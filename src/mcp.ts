// Where an agent finds `fug mcp`: the registration entry, the JSON files that hold it and the table Codex reads.
import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { delimiter, dirname, join } from "node:path";
import { parse, stringify } from "smol-toml";
import { object, save } from "./files.js";

interface Entry {
    command: string;
    args: string[];
    [key: string]: unknown;
}

// `fug mcp` when the command is on PATH, else the interpreter and script of this installation.
export function command(): Entry {
    const found = (process.env.PATH ?? "")
        .split(delimiter)
        .some((dir) => existsSync(join(dir, process.platform === "win32" ? "fug.cmd" : "fug")));
    return found
        ? { command: "fug", args: ["mcp"] }
        : { command: process.execPath, args: [join(import.meta.dirname, "cli.js"), "mcp"] };
}

// Adds the fughetta server to a JSON object file, preserving every other entry. A file that is not a JSON object is left for the
// user to edit and reported instead of being replaced.
export async function register(file: string, entry = command()): Promise<string | undefined> {
    let doc: Record<string, unknown> = {};
    try {
        const value = JSON.parse(await readFile(file, "utf8"));
        if (!object(value)) throw new SyntaxError("Not an object");
        doc = value;
    } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT")
            return `${file} is not a JSON object; add the fughetta server by hand: ${JSON.stringify(entry)}`;
    }
    doc.mcpServers = { ...(object(doc.mcpServers) ? doc.mcpServers : {}), fughetta: entry };
    await save(file, doc, 0o644);
    return undefined;
}

// Adds the fughetta server to a Codex configuration file, which declares stdio servers as TOML tables. An existing table is the
// user's and stays as it is. Returns whether the file changed.
export async function registerCodex(file: string, entry = command()): Promise<boolean> {
    let existing = "";
    try {
        existing = await readFile(file, "utf8");
    } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    const configuration = parse(existing);
    const servers = configuration.mcp_servers;
    if (servers !== undefined && !object(servers))
        throw new Error(`${file} must declare mcp_servers as a table`);
    if (servers && Object.hasOwn(servers, "fughetta")) return false;
    const head = existing && !existing.endsWith("\n") ? `${existing}\n` : existing;
    const table = stringify({
        mcp_servers: { fughetta: { command: entry.command, args: entry.args } },
    });
    let updated = head ? `${head}\n${table}` : table;
    try {
        parse(updated);
    } catch {
        // Inline and dotted tables can seal their parent against an appended declaration.
        updated = stringify({
            ...configuration,
            mcp_servers: { ...servers, fughetta: { command: entry.command, args: entry.args } },
        });
    }
    await mkdir(dirname(file), { recursive: true });
    await writeFile(file, updated);
    return true;
}
