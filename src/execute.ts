// `fug build`, `fug test`, `fug run` and `fug language`: sync the checkout, call
// the tool on the core with a progress token and print each stage as it arrives.
import { type Connection, rpcError, Refused } from "./remote.js";
import { type Binding, push } from "./checkout/index.js";
import { object } from "./files.js";
import { callTool, cancelToolCall, planToolCall, report, toolRequest } from "./tool-call.js";

interface Outcome {
    result: Record<string, unknown>;
    ok: boolean;
    cancelled?: boolean;
}

export async function execute(
    core: Connection,
    binding: Binding,
    root: string,
    tool: string,
    args: Record<string, unknown>,
    note: (line: string) => void,
    sync: typeof push = push,
): Promise<Outcome> {
    const plan = planToolCall(binding, tool, args);
    const request = toolRequest(plan.path);
    const signal = request.controller.signal;
    const interrupt = () => {
        request.controller.abort();
        void cancelToolCall(core, request).catch(() => {});
    };
    process.once("SIGINT", interrupt);
    let stage = "";
    try {
        const synchronized = plan.synchronize
            ? await sync({ ...core, signal }, binding, root)
            : undefined;
        if (synchronized) report(synchronized, note);
        const reply = await callTool(
            core,
            binding,
            root,
            request,
            { name: tool, arguments: plan.arguments(synchronized) },
            synchronized,
            600_000,
            (_, params) => {
                const message = params.message;
                if (typeof message === "string" && message && message !== stage) {
                    stage = message;
                    note(`${tool}: ${message}`);
                }
            },
        );
        if (reply.error) throw rpcError(reply.error);
        if (!object(reply.result))
            throw new Refused("invalid_response", "The core sent no MCP result");
        if (
            reply.result.isError &&
            object(reply.result.structuredContent) &&
            typeof reply.result.structuredContent.code === "string"
        )
            throw new Refused(
                reply.result.structuredContent.code,
                String(reply.result.structuredContent.message ?? "The tool refused the call"),
            );
        const structured = object(reply.result.structuredContent)
            ? reply.result.structuredContent
            : undefined;
        const ok =
            typeof structured?.ok === "boolean"
                ? structured.ok && reply.result.isError !== true
                : reply.result.isError !== true;
        const queryFailed =
            tool === "language" && ["failed", "expired"].includes(String(structured?.status));
        return { result: reply.result, ok: ok && !queryFailed };
    } catch (error) {
        if (signal.aborted) return { result: {}, ok: false, cancelled: true };
        throw error;
    } finally {
        process.off("SIGINT", interrupt);
    }
}

function formatTimings(value: unknown): string {
    if (!object(value)) return "";
    const stages = [
        ["client_sync_seconds", "local sync"],
        ["sync_seconds", "worker sync"],
        ["queue_seconds", "queue"],
        ["dependency_seconds", "dependencies"],
        ["worker_seconds", "worker total"],
        ["preparation_seconds", "environment preparation"],
        ["execution_seconds", "commands and analysis"],
    ];
    return stages
        .filter(([key]) => typeof value[key!] === "number")
        .map(([key, label]) => `${label} ${(value[key!] as number).toFixed(2)}s`)
        .join(", ");
}

// One summary line per configuration, then the diagnostics and failing steps a human debugs with.
export function format(tool: string, result: Record<string, unknown>): string[] {
    const lines: string[] = [];
    const structured = object(result.structuredContent) ? result.structuredContent : undefined;
    if (!structured || !Array.isArray(structured.results)) {
        if (Array.isArray(result.content))
            for (const item of result.content)
                if (object(item) && item.type === "text" && typeof item.text === "string")
                    lines.push(item.text);
        return lines.length ? lines : [JSON.stringify(result.structuredContent ?? null)];
    }
    for (const item of structured.results) {
        if (!object(item)) continue;
        const seconds = typeof item.seconds === "number" ? ` in ${item.seconds.toFixed(1)}s` : "";
        lines.push(
            `${item.ok === true ? "ok" : "FAILED"}  ${String(item.configuration ?? "?")}${seconds}${item.worker ? ` on ${item.worker}` : ""}`,
        );
        const stages = formatTimings(item.timings);
        if (stages) lines.push(`  ${stages}`);
        if (typeof item.error === "string" && item.error) lines.push(`  ${item.error}`);
        if (object(item.tests) && typeof item.tests.total === "number") {
            lines.push(`  tests: ${item.tests.total} total, ${item.tests.failed} failed`);
            for (const name of Array.isArray(item.tests.failed_tests)
                ? item.tests.failed_tests.slice(0, 10)
                : [])
                lines.push(`    FAILED ${String(name)}`);
        }
        if (Array.isArray(item.diagnostics))
            for (const diagnostic of item.diagnostics.slice(0, 20)) {
                if (!object(diagnostic)) continue;
                const at = [diagnostic.file, diagnostic.line, diagnostic.column]
                    .filter(
                        (v) =>
                            (typeof v === "string" && v !== "") || (typeof v === "number" && v > 0),
                    )
                    .join(":");
                lines.push(
                    `  ${at ? `${at}: ` : ""}${diagnostic.severity ? `${diagnostic.severity}: ` : ""}${String(diagnostic.message ?? "")}`,
                );
            }
        if (Array.isArray(item.steps))
            for (const step of item.steps) {
                if (!object(step)) continue;
                const tasks = Array.isArray(step.tasks) ? step.tasks : [];
                if (step.exit_code === 0 && tasks.length < 2) continue;
                const duration =
                    typeof step.seconds === "number" ? ` in ${step.seconds.toFixed(1)}s` : "";
                const where =
                    typeof step.output_file === "string" && step.output_file
                        ? ` (full output: ${step.output_file})`
                        : "";
                lines.push(
                    `  step ${String(step.name ?? "?")}${step.exit_code === 0 ? " completed" : ` exited with ${String(step.exit_code)}`}${duration}${where}`,
                );
                if (tasks.length) lines.push(`    tasks: ${tasks.join(", ")}`);
                if (step.exit_code !== 0 && typeof step.output === "string" && step.output.trim())
                    lines.push(
                        ...step.output
                            .trimEnd()
                            .split("\n")
                            .map((line) => `    ${line}`),
                    );
            }
        if (Array.isArray(item.exports))
            for (const file of item.exports) {
                if (!object(file)) continue;
                if (typeof file.local_path === "string" && file.local_path)
                    lines.push(`  exported ${String(file.name ?? "?")}: ${file.local_path}`);
                else if (typeof file.delivery_error === "string" && file.delivery_error)
                    lines.push(
                        `  export ${String(file.name ?? "?")} failed: ${file.delivery_error}`,
                    );
            }
    }
    const total = structured.results.length,
        ok = structured.results.filter((item) => object(item) && item.ok === true).length;
    lines.push(
        `${tool} ${structured.ok === true ? "succeeded" : "failed"}: ${ok}/${total} configuration${total === 1 ? "" : "s"}`,
    );
    return lines;
}

export const languageActions = [
    "plan",
    "scopes",
    "symbols",
    "definitions",
    "references",
    "relations",
    "impact",
    "diagnostics",
    "schema",
    "describe",
    "inspect",
];

// Published records retain source ranges and artifact member locations.
export function formatLanguage(result: Record<string, unknown>): string[] {
    const lines: string[] = [];
    const structured = object(result.structuredContent) ? result.structuredContent : undefined;
    if (!structured) {
        if (Array.isArray(result.content))
            for (const item of result.content)
                if (object(item) && item.type === "text" && typeof item.text === "string")
                    lines.push(item.text);
        return lines.length ? lines : [JSON.stringify(result.structuredContent ?? null)];
    }
    if (object(structured.schema)) return [JSON.stringify(structured.schema, null, 2)];
    if (object(structured.plan)) return [JSON.stringify(structured.plan, null, 2)];
    if (Array.isArray(structured.providers)) {
        for (const provider of structured.providers) {
            if (!object(provider)) continue;
            lines.push(`${String(provider.id)} (${String(provider.adapter)})`);
            for (const key of ["languages", "roles", "operations", "facts"] as const)
                if (Array.isArray(provider[key]) && provider[key].length)
                    lines.push(`  ${key}: ${provider[key].join(", ")}`);
            for (const port of Array.isArray(provider.ports) ? provider.ports : [])
                if (object(port))
                    lines.push(
                        `  ${String(port.direction)} ${String(port.name)}: ${String(port.type)}${port.required ? " (required)" : ""}${port.multiple ? " (multiple)" : ""}`,
                    );
        }
        return lines;
    }
    if (Array.isArray(structured.outline)) {
        lines.push(`Syntax outline on ${String(structured.worldline)} at ${String(structured.version)}`);
        for (const entry of structured.outline)
            if (object(entry) && object(entry.source))
                lines.push(
                    `${String(entry.kind)} ${String(entry.name)} at ${String(entry.source.path)} [${String(entry.source.begin)}, ${String(entry.source.end)})`,
                );
        if (typeof structured.message === "string") lines.push(structured.message);
        return lines;
    }
    lines.push(
        `${String(structured.configuration ?? "?")} on ${String(structured.worldline ?? "?")} at ${String(structured.version ?? "?")}` +
            `${structured.stale === true ? " (stale analysis)" : ""}`,
    );
    const stages = formatTimings(structured.timings);
    if (stages) lines.push(stages);
    const locator = (value: unknown): string => {
        if (!object(value)) return "";
        if (object(value.source)) {
            const at = value.source;
            const position = object(value.position) ? value.position : undefined;
            return `${String(at.path)}${position ? `:${String(position.line)}:${String(position.column)}` : ` +${String(at.begin ?? 0)}`}`;
        }
        if (object(value.artifact)) {
            const at = value.artifact;
            return `${String(at.artifact ?? at.module ?? "?")}:${String(at.member ?? "")} +${String(at.offset ?? 0)}`;
        }
        return "";
    };
    if (Array.isArray(structured.diagnostics))
        for (const item of structured.diagnostics) {
            if (!object(item)) continue;
            const at = locator(item.location);
            lines.push(
                `${at ? `${at}: ` : ""}${item.severity ? `${item.severity}: ` : ""}${String(item.message ?? "")}`,
            );
        }
    if (typeof structured.view === "string") lines.push(`View: ${structured.view}`);
    if (structured.status && structured.status !== "complete")
        lines.push(
            `Status: ${structured.status}${structured.message ? ` — ${structured.message}` : ""}`,
        );
    if (object(structured.coverage) && Array.isArray(structured.coverage.missing))
        for (const missing of structured.coverage.missing) {
            if (!object(missing)) continue;
            const scope = object(missing.scope) ? missing.scope : {};
            const details = [scope.files, scope.contexts, scope.facts].flatMap((values) =>
                Array.isArray(values) ? values : [],
            );
            const preview = details.slice(0, 4);
            if (details.length > preview.length)
                preview.push(`+${details.length - preview.length} more`);
            lines.push(
                `Missing: ${String(missing.reason ?? "analysis incomplete")}${preview.length ? ` (${preview.join(", ")})` : ""}`,
            );
        }
    if (Array.isArray(structured.items) && structured.items.length) {
        const types = new Map<string, Record<string, unknown>>();
        if (Array.isArray(structured.types))
            for (const type of structured.types)
                if (object(type) && typeof type.id === "string") types.set(type.id, type);
        const typeName = (id: unknown, visited = new Set<string>()): string => {
            if (typeof id !== "string") return "?";
            const type = types.get(id);
            if (!type || visited.has(id) || visited.size >= 32) return id;
            visited.add(id);
            const child = (value: unknown) => typeName(value, new Set(visited));
            const children = (value: unknown) => (Array.isArray(value) ? value.map(child) : []);
            const argumentName = (value: unknown, depth = 0): string => {
                if (!object(value)) return "?";
                if (depth >= 32) return "…";
                if (value.kind === "type") return child(value.type);
                if (value.kind === "pack")
                    return `pack<${(Array.isArray(value.elements) ? value.elements : []).map((element) => argumentName(element, depth + 1)).join(", ")}>`;
                const declaration =
                    typeof value.declaration === "string" ? `[${value.declaration}]` : "";
                const label = declaration
                    ? `${String(value.kind)} ${declaration}`
                    : String(value.value || value.kind);
                return `${label}${value.type ? `: ${child(value.type)}` : ""}`;
            };
            const arguments_ = children(type.arguments);
            const elements = children(type.elements);
            const qualifiers = Array.isArray(type.qualifiers) ? type.qualifiers.join(" ") : "";
            const qualified = (value: string) => (qualifiers ? `${qualifiers} ${value}` : value);
            if (type.kind === "function") {
                const groups = Array.isArray(type.parameter_groups) ? type.parameter_groups : [];
                const generics = children(type.type_parameters);
                return qualified(
                    (generics.length ? `<${generics.join(", ")}> ` : "") +
                        (type.receiver ? `${child(type.receiver)}. ` : "") +
                        groups
                            .map((group) =>
                                object(group) && Array.isArray(group.parameters)
                                    ? `(${group.parameters.map((parameter) => (object(parameter) ? [...(Array.isArray(parameter.modifiers) ? parameter.modifiers : []), child(parameter.type)].join(" ") : "?")).join(", ")})`
                                    : "()",
                            )
                            .join(" ") +
                        ` -> ${child(type.return_type)}`,
                );
            }
            if (type.kind === "tuple") return qualified(`(${elements.join(", ")})`);
            if (type.kind === "intersection") return qualified(elements.join(" & "));
            if (type.kind === "flexible")
                return qualified(`(${child(type.lower_bound)} .. ${child(type.upper_bound)})`);
            if (type.kind === "array")
                return qualified(
                    `array<${arguments_[0] ?? elements[0] ?? "?"}${type.array_size === undefined ? "" : `, ${type.array_size}`}>`,
                );
            const name = typeof type.name === "string" && type.name ? type.name : String(type.kind);
            const parameters =
                type.kind === "application"
                    ? (Array.isArray(type.application_arguments)
                          ? type.application_arguments
                          : []
                      ).map((argument) => argumentName(argument))
                    : arguments_.length
                      ? arguments_
                      : elements;
            return qualified(
                `${name}${type.kind === "application" || parameters.length ? `<${parameters.join(", ")}>` : ""}`,
            );
        };
        for (const item of structured.items) {
            if (!object(item)) continue;
            lines.push(
                `${String(item.name)} (${String(item.kind)})  ${String(item.symbol_id)}${item.type_id ? `  ${typeName(item.type_id)}` : ""}` +
                    (item.type_confidence === "tentative" ? " [tentative type]" : ""),
            );
            lines.push(
                `  Context: ${String(item.context ?? "?")}  Module: ${String(item.module ?? "?")}`,
            );
            const declaration = Array.isArray(structured.symbols)
                ? structured.symbols.find(
                      (record) =>
                          object(record) &&
                          record.id === item.symbol_id &&
                          object(record.ownership) &&
                          record.ownership.context === item.context,
                  )
                : undefined;
            if (object(declaration)) {
                const qualifiers = [
                    declaration.visibility,
                    ...(Array.isArray(declaration.modifiers) ? declaration.modifiers : []),
                ].filter(Boolean);
                if (qualifiers.length) lines.push(`  Declaration: ${qualifiers.join(" ")}`);
                const annotations = (value: unknown, indent: string) => {
                    if (object(value))
                        for (const [key, data] of Object.entries(value))
                            lines.push(
                                `${indent}${key}: ${Array.isArray(data) ? data.join(" ") : JSON.stringify(data)}`,
                            );
                };
                annotations(declaration.extensions, "  ");
                for (const parameter of Array.isArray(declaration.parameters)
                    ? declaration.parameters
                    : []) {
                    if (!object(parameter)) continue;
                    lines.push(
                        `  Parameter ${Number(parameter.group ?? 0) + 1}.${Number(parameter.index ?? 0) + 1}: ${String(parameter.name ?? "(unnamed)")}${parameter.default_value === undefined || parameter.default_value === null ? "" : ` = ${String(parameter.default_value)}`}`,
                    );
                    annotations(parameter.annotations, "    ");
                }
            }
            for (const key of ["declarations", "definitions"] as const)
                for (const location of Array.isArray(item[key]) ? item[key] : [])
                    if (object(location))
                        lines.push(
                            `  ${key === "definitions" ? "defined" : "declared"} at ${locator(location)}`,
                        );
        }
    }
    if (structured.status === "ambiguous")
        lines.push(
            `Select a candidate with --view ${String(structured.view)} --entity SYMBOL --context CONTEXT.`,
        );
    if (Array.isArray(structured.scopes))
        for (const item of structured.scopes) {
            if (!object(item)) continue;
            const at = locator(item.location);
            lines.push(
                `${String(item.id)}  ${String(item.kind)} ${String(item.semantic_owner ?? "")}` +
                    `${item.reference ? ` (${item.reference})` : ""}${at ? `  ${at}` : ""}`,
            );
        }
    const names = new Map<string, string>();
    for (const item of Array.isArray(structured.items) ? structured.items : [])
        if (object(item) && typeof item.symbol_id === "string")
            names.set(item.symbol_id, String(item.name));
    const entity = (id: unknown) =>
        names.has(String(id)) ? `${names.get(String(id))} [${String(id)}]` : String(id ?? "?");
    const records = Array.isArray(structured.references) ? structured.references : [];
    for (const item of records) {
        if (!object(item)) continue;
        const roles = Array.isArray(item.roles) ? item.roles.join("/") : "reference";
        const targets = item.target
            ? entity(item.target)
            : (Array.isArray(item.candidates) ? item.candidates.map(entity).join(", ") : "") || "?";
        lines.push(
            `${String(item.id)}  ${roles} ${String(item.resolution)}${item.dispatch ? ` ${item.dispatch}` : ""}  ${targets}  ${locator(item.location)}`,
        );
    }
    for (const item of Array.isArray(structured.relations) ? structured.relations : []) {
        if (!object(item)) continue;
        lines.push(
            `${entity(item.from)} --${String(item.kind)} [${String(item.resolution)}]--> ${entity(item.to)}`,
        );
        const source =
            object(item.ownership) && object(item.ownership.origin)
                ? locator(item.ownership.origin.location)
                : "";
        const origin = [source, item.reference, item.occurrence].filter(Boolean).join("  ");
        if (origin) lines.push(`  Source: ${origin}`);
    }
    const viewNames = new Map<string, Map<string, string>>();
    const comparison = object(structured.comparison) ? structured.comparison : undefined;
    if (comparison) {
        lines.push(`Comparison: ${String(comparison.from_view)} -> ${String(comparison.to_view)}`);
        for (const evidence of Array.isArray(comparison.evidence) ? comparison.evidence : []) {
            if (!object(evidence) || typeof evidence.view !== "string") continue;
            const selected = viewNames.get(evidence.view) ?? new Map<string, string>();
            for (const item of Array.isArray(evidence.items) ? evidence.items : [])
                if (object(item) && typeof item.symbol_id === "string")
                    selected.set(item.symbol_id, String(item.name));
            viewNames.set(evidence.view, selected);
        }
        for (const change of Array.isArray(comparison.changes) ? comparison.changes : []) {
            if (!object(change) || !object(change.subject)) continue;
            lines.push(
                `${Array.isArray(change.kinds) ? change.kinds.join("/") : "change"}: ${String(change.subject.symbol_id)} [${String(change.subject.context)}]`,
            );
        }
        for (const match of Array.isArray(comparison.duplicate_types)
            ? comparison.duplicate_types
            : []) {
            if (!object(match) || !object(match.subject) || !object(match.existing)) continue;
            lines.push(
                `Duplicate type shape: ${String(match.subject_name ?? match.subject.symbol_id)} can reuse ${String(match.existing_name ?? match.existing.symbol_id)} [${String(match.existing.symbol_id)}]`,
            );
        }
        for (const warning of Array.isArray(comparison.topology) ? comparison.topology : []) {
            if (!object(warning) || !Array.isArray(warning.modules)) continue;
            const modules = warning.modules
                .filter(object)
                .map((module) => `${String(module.project)}/${String(module.file ?? module.name)}`);
            if (warning.kind === "cycle") lines.push(`Dependency cycle: ${modules.join(", ")}`);
            if (warning.kind === "fan_out")
                lines.push(
                    `Dependency fan-out: ${modules[0]} (${String(warning.before)} → ${String(warning.after)})`,
                );
        }
        for (const change of Array.isArray(comparison.degraded_types)
            ? comparison.degraded_types
            : []) {
            if (!object(change)) continue;
            if (change.kind === "unsafe_cast")
                lines.push(`Unsafe cast in ${String(change.name)} (${String(change.after)})`);
            else {
                const slot =
                    change.kind === "parameter"
                        ? `parameter ${Number(change.group) + 1}.${Number(change.index) + 1}`
                        : "return value";
                lines.push(
                    `Type degradation in ${String(change.name)} (${slot}): ${String(change.before)} → ${String(change.after)}`,
                );
            }
        }
    }
    for (const change of comparison && Array.isArray(comparison.reanalysis)
        ? comparison.reanalysis
        : []) {
        if (!object(change) || !object(change.unit)) continue;
        lines.push(
            `Reanalysis: ${String(change.unit.project)}/${String(change.unit.stage)}/${String(change.unit.name)}`,
        );
        for (const input of Array.isArray(change.inputs) ? change.inputs : [])
            if (object(input)) lines.push(`  Input changed: ${String(input.name)}`);
        for (const dependency of Array.isArray(change.dependencies) ? change.dependencies : [])
            if (object(dependency) && object(dependency.read))
                lines.push(
                    `  Dependency ${dependency.unavailable ? "unavailable" : "changed"}: ${String(dependency.read.key)}${dependency.read.channel ? ` [${String(dependency.read.channel)}]` : ""}`,
                );
        for (const task of Array.isArray(change.tasks) ? change.tasks : [])
            if (object(task))
                lines.push(
                    `  Associated ${String(task.operation)}: ${String(task.project)}/${String(task.configuration)}/${String(task.task)}`,
                );
    }
    for (const path of Array.isArray(structured.impact) ? structured.impact : []) {
        if (!object(path) || !object(path.seed) || !object(path.target)) continue;
        const label = (id: unknown) => {
            const name = viewNames.get(String(path.view))?.get(String(id));
            return name ? `${name} [${String(id)}]` : entity(id);
        };
        lines.push(
            `${comparison ? `[${String(path.view)}] ` : ""}${String(path.category)} impact${path.tentative ? " (candidate)" : ""}: ${label(path.seed.symbol_id)} -> ${label(path.target.symbol_id)}`,
        );
        for (const step of Array.isArray(path.steps) ? path.steps : []) {
            if (!object(step) || !object(step.from) || !object(step.to)) continue;
            lines.push(
                `  ${label(step.from.symbol_id)} -> ${label(step.to.symbol_id)}  ${String(step.kind)} ${String(step.evidence)}`,
            );
        }
    }
    if (typeof structured.cursor === "string")
        lines.push(
            comparison
                ? `Next page: keep the same action, selector, filters and limit, including --from-view ${String(comparison.from_view)} --to-view ${String(comparison.to_view)}; set --cursor to the decoded JSON string below.`
                : `Next page: keep the same action, selector, filters and limit; set --view to ${String(structured.view)} and --cursor to the decoded JSON string below.`,
            JSON.stringify(structured.cursor),
        );
    if (typeof structured.next_view === "string")
        lines.push(`Continued view: ${structured.next_view}`);
    if (typeof structured.continuation === "string")
        lines.push(
            "Continue: run fug language --continuation with the decoded JSON string below; --budget-nodes, --budget-units and --budget-ms adjust the request budget.",
            JSON.stringify(structured.continuation),
        );
    return lines;
}
