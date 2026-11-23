import { createHash } from "node:crypto";
import { Refused, type Connection } from "../remote.js";
import { worldline } from "../worldline.js";
import type { Binding } from "./binding.js";

export const digestOf = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");

interface FileContent {
    digest: string;
    size: number;
}

export interface FileEntry extends FileContent {
    kind: string;
    executable: boolean;
    data_base64?: string;
}

export function verifiedBytes(file: FileContent & { data_base64?: string }, label: string): Buffer {
    if (typeof file.data_base64 === "string") {
        const bytes = Buffer.from(file.data_base64, "base64");
        if (bytes.length === file.size && digestOf(bytes) === file.digest) return bytes;
    }
    throw new Refused("invalid_response", `Source content verification failed for ${label}`);
}

export async function readSource(
    core: Connection,
    binding: Binding,
    version: string,
    path: string,
    expected: FileContent,
): Promise<{ file: FileEntry; bytes: Buffer }> {
    const read = (await worldline(core, binding, "read", { version, path })) as FileEntry & {
        version: string;
        truncated?: boolean;
    };
    if (read.truncated || read.version !== version)
        throw new Refused("invalid_response", `Incomplete source file: ${path}`);
    if (read.digest !== expected.digest || read.size !== expected.size)
        throw new Refused(
            "invalid_response",
            `Source metadata differs from the manifest for ${path}`,
        );
    const { digest, size, kind, executable, data_base64 } = read;
    const file = { digest, size, kind, executable, data_base64 };
    return { file, bytes: verifiedBytes(file, path) };
}
