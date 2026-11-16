// The commands `fug mcp` offers as MCP prompts. A client that lists prompts shows them as its own slash commands, so the
// checkout holds no command files.
interface Prompt {
    description: string;
    // The one argument the command takes, when it takes one.
    argument?: { name: string; description: string; required: boolean };
    text(value: string | undefined): string;
}

const prompts: Record<string, Prompt> = {
    sync: {
        description: "Send this checkout's edits to Fughetta",
        text: () =>
            "Run `fug push` in the project root, then report the files it sent, kept and set aside.",
    },
    build: {
        description: "Build a Fughetta configuration",
        argument: {
            name: "configuration",
            description: "The configuration to build; the project's defaults when absent",
            required: false,
        },
        text: (configuration) =>
            `Call the \`build\` tool${configuration ? ` for the configuration ${configuration}` : ""}. Report the failing step and its output, or that the build succeeded.`,
    },
    test: {
        description: "Test a Fughetta configuration",
        argument: {
            name: "configuration",
            description: "The configuration to test; the project's defaults when absent",
            required: false,
        },
        text: (configuration) =>
            `Call the \`test\` tool${configuration ? ` for the configuration ${configuration}` : ""}. Report the failing tests and the step that produced them, or that every test passed.`,
    },
    language: {
        description: "Query a symbol with the Fughetta language tool",
        argument: { name: "symbol", description: "The symbol's name", required: true },
        text: (symbol) =>
            `Call the \`language\` tool with the action \`inspect\` and a name selector for ${symbol}. When it lists candidates, query the matching one by its entity and include its type and scope instead of searching the source by hand.`,
    },
    worldline: {
        description: "Inspect, fork or check out a Fughetta source version",
        argument: {
            name: "command",
            description: "list, fork NAME, or checkout NAME DIRECTORY",
            required: false,
        },
        text: (command) =>
            `Run \`fug worldline${command ? ` ${command}` : ""}\` in the project root. Use \`list\` before \`fork NAME\`, and \`checkout NAME DIRECTORY\` to work on a version in a new directory without leaving this checkout.`,
    },
};

// The `prompts/list` result.
export function listed(): unknown {
    return {
        prompts: Object.entries(prompts).map(([name, prompt]) => ({
            name,
            description: prompt.description,
            ...(prompt.argument ? { arguments: [prompt.argument] } : {}),
        })),
    };
}

// The `prompts/get` result, or a message saying why the request has none.
export function prompted(name: unknown, given: unknown): unknown | string {
    const prompt =
        typeof name === "string" && Object.hasOwn(prompts, name) ? prompts[name] : undefined;
    if (!prompt) return `unknown prompt: ${String(name)}`;
    const values = given !== null && typeof given === "object" ? given : {};
    const value = prompt.argument
        ? (values as Record<string, unknown>)[prompt.argument.name]
        : undefined;
    if (value !== undefined && typeof value !== "string")
        return `${prompt.argument!.name} must be a string`;
    if (prompt.argument?.required && !value) return `${name} needs ${prompt.argument.name}`;
    return {
        description: prompt.description,
        messages: [
            { role: "user", content: { type: "text", text: prompt.text(value || undefined) } },
        ],
    };
}
