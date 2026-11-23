import { randomUUID } from "node:crypto";
import { type Binding, type Pushed, changed } from "./checkout/index.js";
import { object } from "./files.js";
import { localReports, localExports } from "./delivery.js";
import { call, rpc, responseError, Refused, type Connection } from "./remote.js";

export const routes: Record<string, [string, boolean]> = Object.fromEntries([
    ...["configurations", "build", "test", "run", "language"].map((n) => [n, ["/mcp", true]]),
    ...["project", "save_project", "effective", "schema"].map((n) => [n, ["/mcp/config", false]]),
]);
// Source tools use the requested version, the checkout pin, or the completed push.
const pinned = new Set(["build", "test", "run", "language"]);

function fixedAnalysis(name: string, args: Record<string, unknown>): boolean {
    return (
        name === "language" &&
        [args.view, args.from_view, args.to_view, args.continuation].some(
            (value) => typeof value === "string" && value.length > 0,
        )
    );
}

function analysisMetadata(name: string, args: Record<string, unknown>): boolean {
    return name === "language" && ["schema", "describe", "plan"].includes(String(args.action));
}
export const deliversFiles = (name: string) => ["build", "test", "run"].includes(name);

export function planToolCall(binding: Binding, name: string, args: Record<string, unknown>) {
    const route = Object.hasOwn(routes, name) ? routes[name] : undefined;
    if (!route) throw new Refused("invalid_params", `Unknown tool: ${name}`);
    const [path, sources] = route;
    const fixedView = fixedAnalysis(name, args);
    const version =
        typeof args.version === "string" && args.version ? args.version : binding.version;
    return {
        path,
        synchronize: sources && !fixedView && !version && !analysisMetadata(name, args),
        arguments: (synchronized?: Pushed) => ({
            ...args,
            project: binding.project,
            ...(pinned.has(name) && !fixedView
                ? { worldline: binding.worldline, version: version ?? synchronized?.version }
                : {}),
        }),
    };
}

export function toolRequest(path: string) {
    return { path, id: `fug-${randomUUID()}`, controller: new AbortController(), sent: false };
}

export async function cancelToolCall(core: Connection, request: ReturnType<typeof toolRequest>) {
    if (!request.sent) return;
    request.sent = false;
    const reply = await call(
        core,
        "POST",
        request.path,
        { jsonrpc: "2.0", method: "notifications/cancelled", params: { requestId: request.id } },
        3_000,
    );
    if (reply.status !== 202 && reply.status !== 200) throw responseError(reply);
}

export async function callTool(
    core: Connection,
    binding: Binding,
    root: string,
    request: ReturnType<typeof toolRequest>,
    params: { name: string; arguments: Record<string, unknown>; _meta?: unknown },
    synchronized: Pushed | undefined,
    timeout: number,
    progress: (notification: Record<string, unknown>, params: Record<string, unknown>) => void,
) {
    const signal = request.controller.signal;
    signal.throwIfAborted();
    const progressToken = randomUUID();
    request.sent = true;
    const remote = { ...core, signal };
    const reply = await rpc(
        remote,
        request.path,
        {
            jsonrpc: "2.0",
            id: request.id,
            method: "tools/call",
            params: {
                ...params,
                _meta: {
                    ...(object(params._meta) ? params._meta : {}),
                    progressToken,
                    "fughetta/client_sync_seconds": synchronized?.client_sync_seconds,
                },
            },
        },
        timeout,
        (notification) => {
            if (
                object(notification) &&
                object(notification.params) &&
                notification.params.progressToken === progressToken
            )
                progress(notification, notification.params);
        },
    );
    request.sent = false;
    if (!object(reply) || (!("result" in reply) && !("error" in reply)))
        throw new Refused("invalid_response", "The core sent an invalid MCP reply");
    if (deliversFiles(params.name) && object(reply.result) && reply.result.isError !== true) {
        await localExports(remote, binding.project, root, reply.result);
        signal.throwIfAborted();
        await localReports(root, reply.result);
    }
    signal.throwIfAborted();
    return reply;
}

export function report(p: Pushed, output: (line: string) => void, details = output) {
    for (const path of p.skipped) details(`skipped ${path}`);
    for (const path of p.deferred ?? [])
        details(
            `deferred ${path}; review the synchronization details above and run fug push again`,
        );
    for (const path of p.kept) details(`kept ${path}`);
    for (const path of p.preserved ?? []) details(`preserved content at ${path}`);
    for (const conflict of p.conflicts ?? []) details(`source conflict ${conflict}`);
    output(
        changed(p)
            ? `Sent ${p.created} new, ${p.written} changed and ${p.removed} removed files; the project is at version ${p.version}`
            : `Nothing to send; the project is at version ${p.version}`,
    );
}
