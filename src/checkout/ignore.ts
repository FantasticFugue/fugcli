// Which paths of a checkout are not sent: .gitignore and .fughettaignore files at every level, with gitignore semantics, the
// rules `fug init` keeps in .fughetta/ignore for the root, plus version control data, this checkout's own directory and
// installed packages, which no file can bring back.
import ignore, { type Ignore } from "ignore";
import { lstat, readFile } from "node:fs/promises";
import { join } from "node:path";

const never = new Set([".git", ".hg", ".jj", ".svn", "node_modules"]);

// Where `fug init` records the generated directories it detects, so that it never edits the project's own ignore files.
export const generated = ".fughetta/ignore";

// Git matches without case where the file system usually ignores it.
const ignorecase = process.platform !== "linux";

// The rules of one directory's ignore files, matched against paths relative to that directory.
interface Level {
    base: string;
    rules: Ignore;
}

export class Rules {
    private constructor(private readonly levels: Level[]) {}

    static root(): Rules {
        return new Rules([]);
    }

    // These rules plus those of the ignore files in `dir`, whose path relative to the checkout is `relative` ('' at the root). As in
    // Git, an ignore file that is a link is not followed.
    async enter(dir: string, relative: string): Promise<Rules> {
        let rules: Ignore | undefined;
        for (const name of [".gitignore", ".fughettaignore", ...(relative ? [] : [generated])]) {
            const path = join(dir, name);
            try {
                if (!(await lstat(path)).isFile()) continue;
            } catch (error) {
                if ((error as NodeJS.ErrnoException).code === "ENOENT") continue;
                throw error;
            }
            (rules ??= ignore({ ignorecase })).add(await readFile(path, "utf8"));
        }
        return rules ? new Rules([...this.levels, { base: relative, rules }]) : this;
    }

    // Whether `path` (relative to the checkout, '/' separated) is ignored. The deepest ignore file with a matching rule decides.
    ignored(path: string, directory: boolean): boolean {
        const name = path.slice(path.lastIndexOf("/") + 1);
        if (never.has(name) || path === ".fughetta") return true;
        for (let i = this.levels.length - 1; i >= 0; --i) {
            const { base, rules } = this.levels[i]!;
            const inner = (base ? path.slice(base.length + 1) : path) + (directory ? "/" : "");
            const verdict = rules.test(inner);
            if (verdict.ignored) return true;
            if (verdict.unignored) return false;
        }
        return false;
    }
}
