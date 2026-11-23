import { createServer, type Server, type Socket } from "node:net";
import { pipeline } from "node:stream";
import WebSocket, { createWebSocketStream } from "ws";
import { httpUrl } from "./remote.js";

const protocol = "fughetta-worker.v1";
const chunkSize = 16 * 1024;

function bridge(local: Socket, endpoint: URL, ca: Buffer | undefined, log: (line: string) => void) {
    const ws = new WebSocket(endpoint, [protocol], {
        ca,
        handshakeTimeout: 30_000,
        maxPayload: 1 << 20,
        perMessageDeflate: false,
    });
    const finish = (error?: Error | null) => {
        if (error && !local.destroyed) log(`fug: ${error.message}`);
        local.destroy();
        ws.terminate();
    };
    local.once("close", () => finish());
    local.once("error", finish);
    ws.once("error", finish);
    ws.on("message", (_, isBinary) => {
        if (!isBinary) finish(new Error("The Worker tunnel sent a non-binary message"));
    });
    ws.once("open", () => {
        const stream = createWebSocketStream(ws, { highWaterMark: chunkSize });
        pipeline(stream, local, finish);
        pipeline(
            local,
            async function* (source: AsyncIterable<Buffer>) {
                for await (const bytes of source)
                    for (let offset = 0; offset < bytes.length; offset += chunkSize)
                        yield bytes.subarray(offset, offset + chunkSize);
            },
            stream,
            finish,
        );
    });
}

// Each loopback connection is relayed through its own WebSocket.
export async function relay(
    url: string,
    ca?: Buffer,
    log: (line: string) => void = console.error,
): Promise<{ address: string; server: Server }> {
    const endpoint = httpUrl(url);
    endpoint.protocol = endpoint.protocol === "https:" ? "wss:" : "ws:";
    const server = createServer((local) => bridge(local, endpoint, ca, log));
    await new Promise<void>((resolve, reject) => {
        server.once("error", reject);
        server.listen(0, "127.0.0.1", resolve);
    });
    return { address: `127.0.0.1:${(server.address() as { port: number }).port}`, server };
}
