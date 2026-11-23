import { ArgumentParser, SUPPRESS } from "argparse";
import { Refused } from "./remote.js";

export function parseArguments(
    command: string,
    args: string[],
    valueOptions: readonly string[],
    positionals = false,
    switches: readonly string[] = [],
    repeat: readonly string[] = [],
): { words: string[]; flags: Record<string, string | boolean | string[]> } {
    const parser = new ArgumentParser({
        prog: `fug ${command}`,
        add_help: false,
        allow_abbrev: false,
    });
    parser.error = (message) => {
        const unknown = /^unrecognized arguments: (.+)$/.exec(message);
        const missing = /^argument (--[^:]+): expected one argument$/.exec(message);
        throw new Refused(
            "invalid_params",
            unknown
                ? `Unknown option ${unknown[1]}`
                : missing
                  ? `${missing[1]} needs a value`
                  : message,
        );
    };
    if (positionals) parser.add_argument("words", { nargs: "*" });
    for (const key of valueOptions)
        parser.add_argument(`--${key}`, { dest: key, action: "append", default: SUPPRESS });
    for (const key of switches)
        parser.add_argument(`--${key}`, {
            dest: key,
            action: "append_const",
            const: true,
            default: SUPPRESS,
        });
    const { words = [], ...parsed } = parser.parse_intermixed_args<{
        words?: string[];
        [key: string]: string[] | true[] | undefined;
    }>(args);
    const flags: Record<string, string | boolean | string[]> = {};
    for (const [key, values] of Object.entries(parsed)) {
        if (!values?.length) continue;
        if (repeat.includes(key)) flags[key] = values as string[];
        else {
            if (values.length !== 1) throw new Refused("invalid_params", `Repeated --${key}`);
            if (values[0] === "") throw new Refused("invalid_params", `--${key} needs a value`);
            flags[key] = values[0]!;
        }
    }
    return { words, flags };
}
