// Where an agent finds `fug mcp`: the registration `fug init` writes for Claude Code and Codex, and the prompts the server
// offers in place of command files.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { register, registerCodex } from "../build/mcp.js";
import { listed, prompted } from "../build/prompts.js";
import { scratch } from "./service.mjs";

const read = (root, path) => readFile(join(root, path), "utf8");

test("the Codex table is written once beside the tables the file already holds", async () => {
    const root = await scratch("registration-codex");
    try {
        const file = join(root, ".codex/config.toml");
        assert.equal(await registerCodex(file), true);
        assert.match(
            await read(root, ".codex/config.toml"),
            /^\[mcp_servers\.fughetta\]\ncommand = ".+"\nargs = \[.*"mcp"\]\n$/,
        );
        await writeFile(file, '[mcp_servers.other]\ncommand = "other"');
        assert.equal(await registerCodex(file), true);
        const first = await read(root, ".codex/config.toml");
        assert.match(
            first,
            /^\[mcp_servers\.other\]\ncommand = "other"\n\n\[mcp_servers\.fughetta\]\n/,
        );
        assert.equal(await registerCodex(file), false);
        assert.equal(await read(root, ".codex/config.toml"), first);
    } finally {
        await rm(root, { recursive: true, force: true });
    }
});

test("a JSON server map keeps its entries, and one that is not an object is reported and left alone", async () => {
    const root = await scratch("registration-json");
    try {
        const file = join(root, ".mcp.json");
        await writeFile(
            file,
            JSON.stringify({ custom: true, mcpServers: { other: { command: "other" } } }),
        );
        assert.equal(await register(file), undefined);
        const saved = JSON.parse(await read(root, ".mcp.json"));
        assert.equal(saved.custom, true);
        assert.equal(saved.mcpServers.other.command, "other");
        assert.equal(saved.mcpServers.fughetta.args.at(-1), "mcp");
        await writeFile(file, "{invalid");
        assert.match(await register(file), /add the fughetta server by hand/);
        assert.equal(await read(root, ".mcp.json"), "{invalid");
    } finally {
        await rm(root, { recursive: true, force: true });
    }
});

test("prompts name their argument and refuse a missing or malformed one", () => {
    const { prompts } = listed();
    assert.deepEqual(
        prompts.map((prompt) => prompt.name),
        ["sync", "build", "test", "language", "worldline"],
    );
    assert.equal(prompts[0].arguments, undefined);
    assert.deepEqual(
        prompts[3].arguments.map((argument) => [argument.name, argument.required]),
        [["symbol", true]],
    );
    assert.match(prompted("build", undefined).messages[0].content.text, /^Call the `build` tool\./);
    assert.match(
        prompted("language", { symbol: "render" }).messages[0].content.text,
        /name selector for render/,
    );
    assert.match(
        prompted("worldline", { command: "list" }).messages[0].content.text,
        /`fug worldline list`/,
    );
    assert.equal(prompted("language", {}), "language needs symbol");
    assert.equal(prompted("build", { configuration: 1 }), "configuration must be a string");
    assert.equal(prompted("deploy", {}), "unknown prompt: deploy");
});
