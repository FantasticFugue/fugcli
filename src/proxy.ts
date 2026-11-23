import { type JSONRPCMessage } from "@modelcontextprotocol/sdk/types.js";
import { deserializeMessage, serializeMessage } from "@modelcontextprotocol/sdk/shared/stdio.js";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { type Connection, rpc } from "./remote.js";
import { type Binding, type Pushed, push, stateDir } from "./checkout/index.js";
import { object, save } from "./files.js";
import { reportSchema } from "./delivery.js";
import { listed, prompted } from "./prompts.js";
import {
    callTool,
    cancelToolCall,
    deliversFiles,
    planToolCall,
    report,
    routes,
    toolRequest,
} from "./tool-call.js";

// The binding decides these, so the agent never sees them.
const bound = new Set(["project", "worldline"]);
const instructions =
    "These tools build, test, run and analyze the project in this directory on a Fughetta core. Edit files on disk with your own tools; changes are sent before source-reading calls unless a version is supplied or the checkout has a pinned version. Build, test, run and language accept a version or @tag; this selection overrides the checkout pin. Language schema, describe and plan calls, plus queries using a view or continuation, skip source synchronization. Files ignored by .gitignore or .fughettaignore are not sent. Tools take no project argument. Answer symbol questions with language instead of searching files or reading whole ones: inspect returns a declaration's signature, its one-hop parameter and result types and its definition; definitions, references and relations follow uses and calls, including across languages. An unconfigured inspect returns a syntax outline. Use a file scope or name selector to narrow it. Start with configurations for build and test commands. Use schema, project and save_project when the project needs build graphs or semantic analysis. Long calls return their final result and stream progress while running. Cancel a call with notifications/cancelled.";

function unbound(value: unknown): unknown {
    if (!object(value) || !object(value.inputSchema)) return value;
    const exposed = { ...value, inputSchema: structuredClone(value.inputSchema) };
    const root = exposed.inputSchema;
    const visited = new Set<object>();
    const hide = (schema: unknown): void => {
        if (!object(schema) || visited.has(schema)) return;
        visited.add(schema);
        if (typeof schema.$ref === "string" && schema.$ref.startsWith("#/")) {
            let target: unknown = root;
            for (const part of schema.$ref.slice(2).split("/"))
                target = object(target)
                    ? target[part.replaceAll("~1", "/").replaceAll("~0", "~")]
                    : undefined;
            hide(target);
        }
        if (object(schema.properties))
            schema.properties = Object.fromEntries(
                Object.entries(schema.properties).filter(([name]) => !bound.has(name)),
            );
        if (Array.isArray(schema.required))
            schema.required = schema.required.filter((name) => !bound.has(String(name)));
        for (const key of ["allOf", "anyOf", "oneOf"])
            if (Array.isArray(schema[key])) schema[key].forEach(hide);
    };
    hide(root);
    return exposed;
}

export class Proxy {
    private listing?: Promise<unknown[]>;
    private pushing: Promise<unknown> = Promise.resolve();
    private pending = new Map<string, ReturnType<typeof toolRequest>>();
    constructor(
        private core: Connection,
        private binding: Binding,
        private root: string,
        private send: (reply: unknown) => void,
        private stderr: (line: string) => void = console.error,
        private sync: typeof push = push,
    ) {}
    private reply(id: string | number, result: unknown) {
        this.send({ jsonrpc: "2.0", id, result });
    }
    private fail(id: string | number | null, code: number, message: string) {
        this.send({ jsonrpc: "2.0", id, error: { code, message } });
    }
    private async cancel(target: ReturnType<typeof toolRequest>) {
        try {
            await cancelToolCall(this.core, target);
        } catch (error) {
            this.stderr(`fug: cancel: ${String(error)}`);
        }
    }
    async line(line: string): Promise<void> {
        if (!line.trim()) return;
        let req: JSONRPCMessage;
        try {
            req = deserializeMessage(line);
        } catch (error) {
            const invalid = !(error instanceof SyntaxError);
            this.fail(
                null,
                invalid ? -32600 : -32700,
                invalid ? "Invalid request" : "Invalid JSON",
            );
            return;
        }
        if (!("method" in req)) {
            this.fail(null, -32600, "Invalid request");
            return;
        }
        const key = (id: unknown) => JSON.stringify(id);
        if (req.method === "notifications/cancelled") {
            const target = this.pending.get(
                key((req.params as { requestId?: unknown } | undefined)?.requestId),
            );
            if (target) {
                target.controller.abort();
                if (!target.sent) return;
                await this.cancel(target);
            }
            return;
        }
        if (!("id" in req)) return;
        const id = req.id as string | number;
        try {
            if (req.method === "initialize") {
                this.reply(id, {
                    protocolVersion: "2025-06-18",
                    capabilities: {
                        tools: { listChanged: false },
                        prompts: { listChanged: false },
                    },
                    serverInfo: { name: "fughetta", version: "0.1.0" },
                    instructions,
                });
            } else if (req.method === "ping") this.reply(id, {});
            else if (req.method === "prompts/list") this.reply(id, listed());
            else if (req.method === "prompts/get") {
                const p = object(req.params) ? req.params : {};
                const found = prompted(p.name, p.arguments);
                if (typeof found === "string") this.fail(id, -32602, found);
                else this.reply(id, found);
            } else if (req.method === "tools/list") {
                this.listing ??= this.tools().catch((error) => {
                    this.listing = undefined;
                    throw error;
                });
                this.reply(id, { tools: await this.listing });
            } else if (req.method === "tools/call") {
                const p = req.params;
                if (
                    !object(p) ||
                    typeof p.name !== "string" ||
                    ("arguments" in p && !object(p.arguments))
                ) {
                    this.fail(id, -32602, "Tool params need a name and object arguments");
                    return;
                }
                if (!Object.hasOwn(routes, p.name)) {
                    this.fail(id, -32602, `unknown tool: ${p.name}`);
                    return;
                }
                const plan = planToolCall(
                    this.binding,
                    p.name,
                    (p.arguments ?? {}) as Record<string, unknown>,
                );
                const forwarded = toolRequest(plan.path);
                const signal = forwarded.controller.signal;
                this.pending.set(key(id), forwarded);
                let synchronized: Pushed | undefined;
                try {
                    if (plan.synchronize) {
                        const task = this.pushing.then(() => {
                            signal.throwIfAborted();
                            return this.sync({ ...this.core, signal }, this.binding, this.root);
                        });
                        this.pushing = task.catch(() => {});
                        try {
                            const sent = await new Promise<Pushed>((resolve, reject) => {
                                const abort = () => reject(new Error("The request was cancelled"));
                                signal.addEventListener("abort", abort, { once: true });
                                task.then(resolve, reject).finally(() =>
                                    signal.removeEventListener("abort", abort),
                                );
                                if (signal.aborted) abort();
                            });
                            report(sent, this.stderr);
                            synchronized = sent;
                        } catch (error) {
                            if (signal.aborted) throw error;
                            this.reply(id, {
                                content: [
                                    {
                                        type: "text",
                                        text: `The directory's changes could not be sent, so the call did not run: ${String(error)}`,
                                    },
                                ],
                                isError: true,
                            });
                            return;
                        }
                    }
                    let progress = 0;
                    const reply = await callTool(
                        this.core,
                        this.binding,
                        this.root,
                        forwarded,
                        { ...p, name: p.name, arguments: plan.arguments(synchronized) },
                        synchronized,
                        60_000,
                        (notification, params) => {
                            const token = (p._meta as { progressToken?: unknown } | undefined)
                                ?.progressToken;
                            if (token === undefined) return;
                            const { total: _total, ...rest } = params;
                            this.send({
                                ...notification,
                                params: { ...rest, progress: ++progress, progressToken: token },
                            });
                        },
                    );
                    if (synchronized) {
                        const { version, created, written, removed } = synchronized;
                        const synchronization: Record<string, unknown> = {
                            version,
                            sent: { created, written, removed },
                        };
                        let truncated = false;
                        const counts: Record<string, number> = {};
                        for (const name of [
                            "updated",
                            "deferred",
                            "preserved",
                            "conflicts",
                            "skipped",
                        ] as const) {
                            const values = synchronized[name] ?? [];
                            counts[name] = values.length;
                            truncated ||=
                                values.length > 16 || values.some((value) => value.length > 256);
                            synchronization[name] = values
                                .slice(0, 16)
                                .map((value) =>
                                    value.length > 256 ? value.slice(0, 253) + "..." : value,
                                );
                        }
                        synchronization.counts = counts;
                        if (truncated) {
                            const report = join(stateDir(this.root), "reports", "sync.json");
                            synchronization.truncated = true;
                            try {
                                await save(report, synchronized);
                                synchronization.report = report;
                            } catch (error) {
                                synchronization.report_error = String(error).slice(0, 256);
                            }
                        }
                        // Preserve spread behavior for the remote content, including invalid non-iterables.
                        if (object(reply.result)) {
                            reply.result.content = [
                                ...((reply.result.content ?? []) as Iterable<unknown>),
                                { type: "text", text: JSON.stringify({ synchronization }) },
                            ];
                        } else if (object(reply.error))
                            reply.error.data = { remote: reply.error.data, synchronization };
                    }
                    this.send({ ...reply, id });
                } catch (error) {
                    if (signal.aborted) this.fail(id, -32800, "The request was cancelled");
                    else {
                        if (forwarded.sent) await this.cancel(forwarded);
                        throw error;
                    }
                } finally {
                    this.pending.delete(key(id));
                }
            } else this.fail(id, -32601, `method not found: ${req.method}`);
        } catch (error) {
            this.fail(id, -32603, String(error));
        }
    }
    private async tools() {
        const out: unknown[] = [];
        for (const path of ["/mcp", "/mcp/config"]) {
            const reply = await rpc(
                this.core,
                path,
                { jsonrpc: "2.0", id: randomUUID(), method: "tools/list" },
                60_000,
            );
            if (
                !object(reply) ||
                !Array.isArray((reply.result as { tools?: unknown } | undefined)?.tools)
            )
                throw new Error("The core sent an invalid tool list");
            for (const tool of (reply.result as { tools: { name: string }[] }).tools)
                if (Object.hasOwn(routes, tool.name) && routes[tool.name]?.[0] === path) {
                    const exposed = unbound(tool) as Record<string, unknown>;
                    if (deliversFiles(tool.name) && exposed.outputSchema)
                        exposed.outputSchema = reportSchema(exposed.outputSchema);
                    out.push(exposed);
                }
        }
        return out;
    }
}
export async function serve(core: Connection, binding: Binding, root: string) {
    const proxy = new Proxy(core, binding, root, (reply) =>
        process.stdout.write(serializeMessage(reply as JSONRPCMessage)),
    );
    const pending = new Set<Promise<void>>();
    for await (const line of createInterface({ input: process.stdin, crlfDelay: Infinity })) {
        const task = proxy.line(line);
        pending.add(task);
        void task.finally(() => pending.delete(task));
    }
    await Promise.all(pending);
}
