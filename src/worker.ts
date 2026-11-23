import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, readdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { call, reason, Refused, type Connection } from "./remote.js";
import { json, locked, save } from "./files.js";
import { relay } from "./tunnel.js";

const releases = "https://api.github.com/repos/FantasticFugue/fughetta-service/releases/latest";
// The Worker exits with this status when the core refuses its identity: revoked, unknown, or registered to another workspace.
const refused = 2;

interface Identity {
    server: string;
    workspace: string;
    workspace_id: string;
    worker_id: string;
    secret: string;
    name: string;
}

function home(): string {
    if (!process.env.HOME) throw new Error("HOME is not set");
    return process.env.HOME;
}
function local(): string {
    if (!process.env.LOCALAPPDATA) throw new Error("LOCALAPPDATA is not set");
    return join(process.env.LOCALAPPDATA, "Fughetta");
}
const workersDir = () =>
    process.platform === "win32"
        ? join(local(), "workers")
        : join(
              process.env.XDG_STATE_HOME || join(home(), ".local", "state"),
              "fughetta",
              "workers",
          );
export function stateDir(server: string, workspace: string): string {
    return join(
        workersDir(),
        `${new URL(server).host.replace(/[^a-zA-Z0-9.-]/g, "_")}-${workspace}`,
    );
}
function cacheDir(): string {
    return process.platform === "win32"
        ? join(local(), "cache", "service")
        : join(process.env.XDG_CACHE_HOME || join(home(), ".cache"), "fughetta", "service");
}
export const unitName = (server: string, workspace: string) =>
    `fughetta-worker-${stateDir(server, workspace).split(/[\\/]/).pop()}.service`;

// Returns this machine's saved identity for the workspace, registering a new one with the owner's token when there is none.
export async function identity(core: Connection, name: string): Promise<Identity> {
    const file = join(stateDir(core.server, core.workspace), "identity.json");
    return locked(
        file,
        async () => {
            const saved = await json<Identity | null>(file, null);
            if (saved) return saved;
            const reply = await call(core, "POST", "/api/v1/workers", { name }, 30_000);
            if (reply.status === 403)
                throw new Error(
                    `Only an owner of ${core.workspace} can add a build machine (${reason(reply)})`,
                );
            if (reply.status !== 201)
                throw new Error(`The build machine could not be registered: ${reason(reply)}`);
            const credential = JSON.parse(reply.body);
            const result = {
                server: core.server,
                workspace: core.workspace,
                workspace_id: credential.workspace_id,
                worker_id: credential.worker_id,
                secret: credential.secret,
                name,
            };
            await save(file, result);
            return result;
        },
        core.signal,
    );
}
// Selects a saved identity for the workspace or the only identity for the server.
export async function savedIdentity(server: string, workspace = ""): Promise<Identity | null> {
    if (workspace)
        return json<Identity | null>(join(stateDir(server, workspace), "identity.json"), null);
    const base = workersDir();
    const found: Identity[] = [];
    for (const entry of await readdir(base).catch(() => [] as string[])) {
        const id = await json<Identity | null>(join(base, entry, "identity.json"), null);
        if (id?.server === server) found.push(id);
    }
    if (found.length > 1) {
        const workspaces = found
            .map((id) => id.workspace)
            .sort()
            .join(", ");
        throw new Refused(
            "invalid_params",
            `Multiple saved Worker identities for ${server} (${workspaces}). Specify --workspace.`,
        );
    }
    return found[0] ?? null;
}

export async function workerStatus(core: Connection, identity: Identity): Promise<string> {
    const reply = await call(core, "GET", "/api/v1/workers", undefined, 30_000);
    if (reply.status !== 200) throw new Error(`Could not read Worker status: ${reason(reply)}`);
    const workers: { worker_id?: string; name: string; online: boolean; revoked_at?: number }[] =
        JSON.parse(reply.body);
    const worker = workers.find((entry) => entry.worker_id === identity.worker_id);
    let status = "unknown";
    if (worker)
        status = worker.revoked_at != null ? "revoked" : worker.online ? "online" : "offline";
    return `${worker?.name ?? identity.name} (${identity.worker_id}) in ${identity.workspace} is ${status}`;
}

const asset = (program: string) =>
    `${program}-${process.platform}-${process.arch}${process.platform === "win32" ? ".exe" : ""}`;

// Downloads the latest fughetta-service release for this platform once, with the fughetta-llvm
// host beside it, checks their SHA-256 digests, and returns the service's path.
export async function service(
    url = releases,
    log: (line: string) => void = console.error,
): Promise<string> {
    const name = asset("fughetta-service");
    let release: Release;
    try {
        const reply = await fetch(url, {
            headers: { accept: "application/vnd.github+json" },
            signal: AbortSignal.timeout(30_000),
        });
        if (!reply.ok) throw new Error(`HTTP ${reply.status}`);
        release = (await reply.json()) as Release;
    } catch (error) {
        throw new Error(
            `The fughetta-service release list is unavailable (${(error as Error).message}); pass --service PATH`,
        );
    }
    if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(release.tag_name))
        throw new Error(`Unexpected release tag ${release.tag_name}`);
    await download(release, asset("fughetta-llvm"), log);
    return download(release, name, log);
}
type Release = {
    tag_name: string;
    assets: { name: string; browser_download_url: string; digest?: string }[];
};
async function download(release: Release, name: string, log: (line: string) => void) {
    const target = join(cacheDir(), release.tag_name, name);
    try {
        await stat(target);
        return target;
    } catch {}
    const entry = release.assets.find((a) => a.name === name);
    if (!entry)
        throw new Error(
            `Release ${release.tag_name} has no ${name} for ${process.platform}-${process.arch}; pass --service PATH`,
        );
    const digest = /^sha256:([0-9a-f]{64})$/.exec(entry.digest ?? "")?.[1];
    if (!digest) throw new Error(`Release ${release.tag_name} lists no SHA-256 digest for ${name}`);
    log(`fug: downloading ${name} ${release.tag_name}`);
    const reply = await fetch(entry.browser_download_url, { signal: AbortSignal.timeout(600_000) });
    if (!reply.ok) throw new Error(`Downloading ${name} failed: HTTP ${reply.status}`);
    const bytes = Buffer.from(await reply.arrayBuffer());
    if (createHash("sha256").update(bytes).digest("hex") !== digest)
        throw new Error(`${name} from ${release.tag_name} does not match its published digest`);
    await mkdir(join(cacheDir(), release.tag_name), { recursive: true });
    const temp = `${target}.${process.pid}`;
    try {
        await writeFile(temp, bytes, { mode: 0o755 });
        await rename(temp, target);
    } finally {
        await rm(temp, { force: true });
    }
    return target;
}
// The helper hosts beside the service binary, as a release download places them, by the name
// stages give them. A service given with --service maps whichever of them sit beside it.
export async function tools(binary: string): Promise<Record<string, string>> {
    const out: Record<string, string> = {};
    const path = join(dirname(resolve(binary)), asset("fughetta-llvm"));
    if (await stat(path).catch(() => undefined)) out["fughetta-llvm"] = path;
    return out;
}
export function configuration(
    id: Identity,
    gateway: string,
    dir: string,
    threads = 8,
    mapped: Record<string, string> = {},
) {
    return {
        gateway,
        worker_id: id.worker_id,
        workspace_id: id.workspace_id,
        token: id.secret,
        name: id.name,
        data_root: join(dir, "data"),
        work_root: join(dir, "work"),
        compute_threads: threads,
        parallel: threads,
        tools: mapped,
    };
}

// Runs the Worker behind a loopback relay until it is stopped or refused, restarting it after other exits.
export async function run(
    id: Identity,
    binary: string,
    threads = 8,
    log: (line: string) => void = console.error,
): Promise<number> {
    const dir = stateDir(id.server, id.workspace);
    const ca = process.env.FUGHETTA_CA_FILE
        ? await readFile(process.env.FUGHETTA_CA_FILE)
        : undefined;
    const tunnel = await relay(`${id.server}/w/${id.workspace}/workers/tunnel`, ca, log);
    const config = join(dir, "worker.json");
    let stopping = false;
    let child: ReturnType<typeof spawn> | undefined;
    const stop = () => {
        stopping = true;
        child?.kill("SIGTERM");
    };
    process.once("SIGINT", stop);
    process.once("SIGTERM", stop);
    log(`fug: ${id.name} serves builds for ${id.workspace} on ${id.server}; stop with Ctrl-C`);
    try {
        await save(config, configuration(id, tunnel.address, dir, threads, await tools(binary)));
        for (let wait = 1000; !stopping;) {
            const started = Date.now();
            const command = [resolve(binary), "worker", "run", "--config", config];
            child = spawn(command[0]!, command.slice(1), {
                stdio: ["ignore", "inherit", "inherit"],
            });
            const code = await new Promise<number>((done) => {
                child!.once("error", (error) => {
                    log(`fug: ${error.message}`);
                    done(1);
                });
                child!.once("exit", (status, signal) => done(status ?? (signal ? 1 : 0)));
            });
            if (stopping) return 0;
            if (code === refused) {
                await rm(join(dir, "identity.json"), { force: true });
                log(
                    `fug: ${id.workspace} refused this machine's identity (it was revoked or removed); run fug worker again to register it anew`,
                );
                return refused;
            }
            if (Date.now() - started > 60_000) wait = 1000;
            log(`fug: the Worker exited with status ${code}; restarting in ${wait / 1000} seconds`);
            await delay(wait);
            wait = Math.min(wait * 2, 30_000);
        }
        return 0;
    } finally {
        process.off("SIGINT", stop);
        process.off("SIGTERM", stop);
        tunnel.server.close();
    }
}

const quote = (arg: string) =>
    `"${arg.replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/%/g, "%%").replace(/\r/g, "\\r").replace(/\n/g, "\\n")}"`;
export function unit(
    server: string,
    workspace: string,
    command: string[],
    extra: string[] = [],
): string {
    // systemd starts the Worker with the user manager's environment. Preserve
    // the state and cache paths used to enroll the machine and find its service.
    const env = ["XDG_STATE_HOME", "XDG_CACHE_HOME", "FUGHETTA_CA_FILE"]
        .flatMap((name) => {
            const path = process.env[name];
            return path ? [`Environment=${quote(`${name}=${resolve(path)}`)}\n`] : [];
        })
        .join("");
    return `[Unit]
Description=Fughetta Worker for ${workspace} on ${new URL(server).host}
Wants=network-online.target
After=network-online.target

[Service]
ExecStart=${[...command, "worker", "--server", server, "--workspace", workspace, ...extra].map((arg) => quote(arg.replaceAll("$", () => "$$"))).join(" ")}
${env}Restart=on-failure
RestartSec=5
RestartPreventExitStatus=${refused}

[Install]
WantedBy=default.target
`;
}
function unitFile(server: string, workspace: string): string {
    return join(
        process.env.XDG_CONFIG_HOME || join(home(), ".config"),
        "systemd",
        "user",
        unitName(server, workspace),
    );
}
function systemctl(...args: string[]) {
    const result = spawnSync("systemctl", ["--user", ...args], {
        stdio: ["ignore", "inherit", "inherit"],
    });
    if (result.error) throw new Error(`systemctl is unavailable: ${result.error.message}`);
    if (result.status !== 0)
        throw new Error(`systemctl --user ${args.join(" ")} failed with status ${result.status}`);
}
export async function install(
    server: string,
    workspace: string,
    command: string[],
    extra: string[] = [],
): Promise<void> {
    if (process.platform !== "linux")
        throw new Error(
            "fug worker install needs systemd; on this system keep fug worker running instead",
        );
    const file = unitFile(server, workspace);
    await mkdir(join(file, ".."), { recursive: true });
    await writeFile(file, unit(server, workspace, command, extra), { mode: 0o644 });
    systemctl("daemon-reload");
    systemctl("enable", "--now", unitName(server, workspace));
    console.log(
        `Installed ${unitName(server, workspace)}; it starts when you sign in. Follow it with: journalctl --user -u ${unitName(server, workspace)} -f`,
    );
    console.log(
        `To keep it running while you are signed out: loginctl enable-linger ${process.env.USER ?? "$USER"}`,
    );
}
export async function uninstall(server: string, workspace: string): Promise<void> {
    if (process.platform !== "linux") throw new Error("fug worker uninstall needs systemd");
    const file = unitFile(server, workspace);
    try {
        await stat(file);
    } catch {
        throw new Error(`${file} does not exist`);
    }
    systemctl("disable", "--now", unitName(server, workspace));
    await rm(file);
    systemctl("daemon-reload");
    console.log(
        `Removed ${unitName(server, workspace)}. The machine stays registered; revoke it in the console to retire it.`,
    );
}
