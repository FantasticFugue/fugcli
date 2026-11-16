// Where an agent finds `fug mcp`: the registration entry, the JSON files that hold it and the table Codex reads.
import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { delimiter, dirname, join } from "node:path";
import { object, save } from "./files.js";

export interface Entry {
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
    if (/^\s*\[mcp_servers\.fughetta\]\s*$/m.test(existing)) return false;
    const head = existing && !existing.endsWith("\n") ? `${existing}\n` : existing;
    const args = entry.args.map((arg) => JSON.stringify(arg)).join(", ");
    const table = `[mcp_servers.fughetta]\ncommand = ${JSON.stringify(entry.command)}\nargs = [${args}]\n`;
    await mkdir(dirname(file), { recursive: true });
    await writeFile(file, head ? `${head}\n${table}` : table);
    return true;
}
