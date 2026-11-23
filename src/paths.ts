import { Refused } from "./remote.js";

export function pathRefusal(path: unknown): string | undefined {
    if (typeof path !== "string" || !path) return "an empty or invalid path";
    for (const part of path.split("/")) {
        if (!part || part === "." || part === "..") return "an invalid path component";
        if (Buffer.byteLength(part) > 255) return "a name longer than 255 bytes";
        if (part.includes("�")) return "a name that is not UTF-8";
        if (/[\x00-\x1f\x7f]/.test(part)) return "a name with a control character";
        if (/[\\:<>"|?*]/.test(part) || /[. ]$/.test(part)) return "a name unsupported on Windows";
        if (/^(?:con|prn|aux|nul|com[1-9¹²³]|lpt[1-9¹²³])(?:\s*\.|$)/i.test(part))
            return "a reserved device name";
    }
    return undefined;
}

export function checkoutPathRefusal(path: string): string | undefined {
    const refused = pathRefusal(path);
    if (refused) return refused;
    const parts = path.toLowerCase().split("/");
    if (parts[0] === ".fughetta" || parts.includes(".git")) return "a reserved checkout path";
    return undefined;
}

export function portablePath(path: unknown): string {
    const refused = pathRefusal(path);
    if (refused) throw new Refused("invalid_path", `Unsupported export path: ${refused}`);
    return path as string;
}
