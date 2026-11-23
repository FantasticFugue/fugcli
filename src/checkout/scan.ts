// The files of a checkout that are sent, with their digests. Hashes of files unchanged since the last scan come from an index in
// `.fughetta/state/index.json`, keyed by modification time, change time, inode and size.
import { lstat, readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { json, save } from "../files.js";
import { stateDir } from "./binding.js";
import { Rules } from "./ignore.js";
import { prefetch } from "./concurrent.js";
import { checkoutPathRefusal } from "../paths.js";
import { digestOf } from "./source.js";

interface File {
    digest: string;
    // Unknown where the file system has no executable flag (Windows); the remote flag is kept then.
    executable?: boolean;
}

export interface Snapshot {
    files: Map<string, File>;
    // Paths that exist but are not sent, each with the reason.
    skipped: Map<string, string>;
}

interface Indexed {
    stamp: string;
    file: File;
}

export async function scan(root: string, limit: number, signal?: AbortSignal): Promise<Snapshot> {
    const indexFile = join(stateDir(root), "index.json");
    const index = await json<Record<string, Indexed>>(indexFile, {});
    const next: Record<string, Indexed> = {};
    const out: Snapshot = { files: new Map(), skipped: new Map() };
    const now = BigInt(Date.now()) * 1_000_000n;
    const posix = process.platform !== "win32";

    const walk = async (dir: string, relative: string, parent: Rules): Promise<void> => {
        signal?.throwIfAborted();
        const rules = await parent.enter(dir, relative);
        const names = (await readdir(dir)).sort();
        const directories: { full: string; path: string }[] = [];
        for await (const { value } of prefetch(names, async (name) => {
            signal?.throwIfAborted();
            const path = relative ? `${relative}/${name}` : name;
            const full = join(dir, name);
            const status = await lstat(full, { bigint: true });
            const directory = status.isDirectory();
            if (rules.ignored(path, directory)) return;
            const refused = checkoutPathRefusal(path);
            if (refused) {
                return { path, skipped: refused };
            }
            if (directory) {
                return { path, directory: full };
            }
            if (!status.isFile()) {
                return { path, skipped: status.isSymbolicLink() ? "a link" : "not a regular file" };
            }
            if (status.size > BigInt(limit)) {
                return { path, skipped: `${status.size} bytes, over the ${limit} byte limit` };
            }
            const stamp = `${status.mtimeNs}:${status.ctimeNs}:${status.ino}:${status.size}`;
            const known = index[path];
            const file: File = {
                digest:
                    known?.stamp === stamp
                        ? known.file.digest
                        : digestOf(await readFile(full, { signal })),
            };
            if (posix) file.executable = (Number(status.mode) & 0o100) !== 0;

            // A file written in the last two seconds may change again within the clock's resolution; it is hashed again next time.
            const indexed =
                now - status.mtimeNs > 2_000_000_000n && now - status.ctimeNs > 2_000_000_000n;
            return { path, file, stamp, indexed };
        })) {
            if (!value) continue;
            if (value.skipped) out.skipped.set(value.path, value.skipped);
            else if (value.directory) directories.push({ full: value.directory, path: value.path });
            else if (value.file) {
                out.files.set(value.path, value.file);
                if (value.indexed) next[value.path] = { stamp: value.stamp!, file: value.file };
            }
        }
        for (const directory of directories) await walk(directory.full, directory.path, rules);
    };
    await walk(root, "", Rules.root());
    await save(indexFile, next, 0o644);
    return out;
}
