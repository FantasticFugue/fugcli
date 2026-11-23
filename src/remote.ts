import { request as httpRequest } from "node:http";
import { request as httpsRequest } from "node:https";
import { readFile } from "node:fs/promises";
import { Readable } from "node:stream";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { JSONRPCRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { randomUUID } from "node:crypto";
import { object } from "./files.js";

export function httpUrl(input: string): URL {
    let url: URL;
    try {
        url = new URL(input);
    } catch {
        throw new Refused("invalid_origin", "Invalid server URL");
    }
    if (
        !["http:", "https:"].includes(url.protocol) ||
        (url.protocol === "http:" && !["127.0.0.1", "localhost", "[::1]"].includes(url.hostname)) ||
        url.username ||
        url.password
    )
        throw new Refused("invalid_origin", "The server URL must use HTTPS or loopback HTTP");
    return url;
}

export function origin(input: string): string {
    const url = httpUrl(input);
    if (url.pathname !== "/" || url.search || url.hash)
        throw new Refused("invalid_origin", "The server URL must name an origin");
    return url.origin;
}

export interface Connection {
    server: string;
    workspace: string;
    token: string;
    signal?: AbortSignal;
}
export class Refused extends Error {
    constructor(
        public code: string,
        message: string,
    ) {
        super(message);
    }
}

// Refusals keep their supplied code; runtime failures map errno and syntax errors to the same CLI categories as their message.
export function failure(error: unknown): { code: string; message: string } {
    if (error instanceof Refused) return { code: error.code, message: error.message };
    const message = error instanceof Error ? error.message : String(error);
    const code = (error as NodeJS.ErrnoException | undefined)?.code;
    const codes: Record<string, string> = {
        ENOENT: "missing_objects",
        ENOTDIR: "missing_objects",
        EACCES: "permission_denied",
        EPERM: "permission_denied",
        ECONNREFUSED: "connection_failed",
        ECONNRESET: "connection_failed",
        ENOTFOUND: "connection_failed",
        EAI_AGAIN: "connection_failed",
        EPIPE: "connection_failed",
        ETIMEDOUT: "timeout",
        ABORT_ERR: "cancelled",
    };
    return {
        code:
            codes[code ?? ""] ?? (error instanceof SyntaxError ? "invalid_data" : "internal_error"),
        message,
    };
}

export function responseError(reply: { status: number; body: string }): Refused {
    let code = `http_${reply.status}`;
    try {
        const value: unknown = JSON.parse(reply.body);
        if (object(value) && typeof value.code === "string") code = value.code;
    } catch {
        /* A non-JSON HTTP error still has its status code. */
    }
    return new Refused(code, reason(reply));
}

export function rpcError(value: unknown): Refused {
    const e = object(value) ? value : {};
    const data = object(e.data) ? e.data : {};
    const codes: Record<string, string> = {
        "-32700": "invalid_data",
        "-32600": "invalid_request",
        "-32601": "method_not_found",
        "-32602": "invalid_params",
        "-32603": "internal_error",
        "-32800": "cancelled",
    };
    const code =
        typeof data.code === "string"
            ? data.code
            : typeof e.code === "string"
              ? e.code
              : (codes[String(e.code)] ?? "rpc_error");
    return new Refused(
        code,
        typeof e.message === "string" ? e.message : "The core returned an MCP error",
    );
}

async function request(
    url: string,
    method: string,
    body: string | undefined,
    headers: Record<string, string>,
    timeout: number,
    signal?: AbortSignal,
    streamError?: (reason: unknown) => void,
): Promise<Response> {
    const endpoint = httpUrl(url);
    signal?.throwIfAborted();
    const ca = process.env.FUGHETTA_CA_FILE
        ? await readFile(process.env.FUGHETTA_CA_FILE)
        : undefined;
    signal?.throwIfAborted();
    return new Promise((resolve, reject) => {
        const req = (endpoint.protocol === "https:" ? httpsRequest : httpRequest)(
            endpoint,
            { method, headers: { accept: "application/json", ...headers }, ca },
            (incoming) => {
                incoming.on("data", () => timer.refresh());
                incoming.once("close", cleanup);
                incoming.once("error", streamError ?? (() => {}));
                const responseHeaders = new Headers();
                for (const [key, value] of Object.entries(incoming.headers))
                    for (const part of value === undefined
                        ? []
                        : Array.isArray(value)
                          ? value
                          : [value])
                        responseHeaders.append(key, part);
                const status = incoming.statusCode!;
                const bodyless =
                    method === "HEAD" || status === 204 || status === 205 || status === 304;
                if (bodyless) incoming.resume();
                const stream = bodyless
                    ? null
                    : (Readable.toWeb(incoming) as unknown as ReadableStream<Uint8Array>);
                resolve(new Response(stream, { status, headers: responseHeaders }));
            },
        );
        // This is an idle deadline. Every received byte, including an SSE heartbeat, renews it.
        const timer = setTimeout(() => {
            const error = new Refused("timeout", `${url} timed out`);
            streamError?.(error);
            req.destroy(error);
        }, timeout);
        const abort = () => req.destroy(new Refused("cancelled", "The request was cancelled"));
        const cleanup = () => {
            clearTimeout(timer);
            signal?.removeEventListener("abort", abort);
        };
        signal?.addEventListener("abort", abort, { once: true });
        req.on("error", (error) => {
            cleanup();
            reject(error);
        });
        req.end(body);
    });
}

export async function exchange(
    url: string,
    method = "GET",
    body?: string,
    headers: Record<string, string> = {},
    timeout = 600_000,
    options: { signal?: AbortSignal } = {},
): Promise<{ status: number; body: string }> {
    const response = await request(url, method, body, headers, timeout, options.signal);
    return { status: response.status, body: await response.text() };
}

export function reason(reply: { status: number; body: string }): string {
    try {
        const e = JSON.parse(reply.body);
        return `HTTP ${reply.status}: ${e.message ?? reply.body}`;
    } catch {
        return `HTTP ${reply.status}: ${reply.body}`;
    }
}

export async function call(
    core: Connection,
    method: string,
    path: string,
    body?: unknown,
    timeout?: number,
) {
    return exchange(
        origin(core.server) + (core.workspace ? `/w/${core.workspace}` : "") + path,
        method,
        body === undefined ? undefined : JSON.stringify(body),
        { "content-type": "application/json", authorization: `Bearer ${core.token}` },
        timeout,
        { signal: core.signal },
    );
}

export async function rpc(
    core: Connection,
    path: string,
    message: Record<string, unknown>,
    timeout?: number,
    notification?: (value: unknown) => void,
): Promise<unknown> {
    const frame = JSONRPCRequestSchema.parse(message);
    core.signal?.throwIfAborted();
    let resolve!: (reply: unknown) => void;
    let reject!: (reason: unknown) => void;
    const answer = new Promise<unknown>((success, failure) => {
        resolve = success;
        reject = failure;
    });
    void answer.catch(() => {});
    let streamed = false;
    let eof: ReturnType<typeof setTimeout> | undefined;
    const transport = new StreamableHTTPClientTransport(
        new URL(origin(core.server) + (core.workspace ? `/w/${core.workspace}` : "") + path),
        {
            reconnectionOptions: {
                initialReconnectionDelay: 0,
                maxReconnectionDelay: 0,
                reconnectionDelayGrowFactor: 1,
                maxRetries: 0,
            },
            fetch: async (url, init) => {
                const headers = Object.fromEntries(new Headers(init?.headers));
                const response = await request(
                    String(url),
                    "POST",
                    String(init?.body),
                    {
                        ...headers,
                        authorization: `Bearer ${core.token}`,
                    },
                    timeout ?? 600_000,
                    init?.signal ?? undefined,
                    reject,
                );
                if (response.status !== 200)
                    throw responseError({ status: response.status, body: await response.text() });
                const media = response.headers.get("content-type")?.split(";")[0]?.trim();
                if (media === "application/json") return response;
                if (media !== "text/event-stream") {
                    await response.body?.cancel();
                    throw new Refused(
                        "invalid_response",
                        "The core sent an unsupported MCP content type",
                    );
                }
                streamed = true;
                let bytes = 0;
                const stream = response.body?.pipeThrough(
                    new TransformStream<Uint8Array, Uint8Array>({
                        transform(chunk, output) {
                            bytes += chunk.byteLength;
                            if (bytes > 64 * 1024 * 1024)
                                throw new RangeError("The MCP response exceeds 64 MiB");
                            output.enqueue(chunk);
                        },
                        flush() {
                            eof = setTimeout(
                                () =>
                                    reject(
                                        new Error(
                                            "The core closed the SSE stream without a final MCP response",
                                        ),
                                    ),
                                0,
                            );
                        },
                    }),
                );
                return new Response(stream, { status: response.status, headers: response.headers });
            },
        },
    );
    transport.onmessage = (value) => {
        if ("method" in value && value.method === "notifications/progress") notification?.(value);
        else if ("id" in value && value.id === frame.id) resolve(value);
    };
    transport.onerror = reject;
    const abort = () => {
        reject(new Refused("cancelled", "The request was cancelled"));
        void transport.close();
    };
    core.signal?.addEventListener("abort", abort, { once: true });
    try {
        await transport.start();
        core.signal?.throwIfAborted();
        await transport.send(frame);
        if (!streamed)
            reject(new Refused("invalid_response", "The core sent no matching MCP reply"));
        return await answer;
    } finally {
        clearTimeout(eof);
        core.signal?.removeEventListener("abort", abort);
        await transport.close();
    }
}

// These views describe fields consumed from MCP; payloads remain unknown.
interface McpResult {
    isError?: unknown;
    structuredContent?: unknown;
    content?: unknown;
}
interface McpFailure {
    code?: string;
    message?: string;
}

export async function tool(
    core: Connection,
    name: string,
    args: unknown,
    path = "/mcp",
): Promise<unknown> {
    const reply = await rpc(core, path, {
        jsonrpc: "2.0",
        id: randomUUID(),
        method: "tools/call",
        params: { name, arguments: args },
    });
    if (!object(reply)) throw new Refused("invalid_response", "The core sent an invalid MCP reply");
    if (reply.error) throw rpcError(reply.error);
    if (!reply.result) throw new Refused("invalid_response", "The core sent no MCP result");
    const result = reply.result as McpResult;
    if (result.isError) {
        const e = result.structuredContent as McpFailure | undefined;
        throw new Refused(e?.code ?? "tool_error", e?.message ?? JSON.stringify(result.content));
    }
    return result.structuredContent;
}
