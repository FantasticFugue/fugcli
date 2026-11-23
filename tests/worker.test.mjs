import { test } from "node:test";
import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import { createHash, createPublicKey, verify } from "node:crypto";
import { createServer, request } from "node:http";
import { mkdir, readFile, rm, stat, symlink, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { promisify } from "node:util";
import { binary, port, scratch, service as missingService } from "./service.mjs";
import { tool } from "../build/remote.js";
import {
    configuration,
    identity,
    savedIdentity,
    service,
    stateDir,
    tools,
    unit,
    unitName,
} from "../build/worker.js";

const cli = resolve(import.meta.dirname, "../build/cli.js");
test("concurrent Worker starts reuse the same registration", async () => {
    const dir = await scratch("worker-registration");
    const variable = process.platform === "win32" ? "LOCALAPPDATA" : "XDG_STATE_HOME";
    const previous = process.env[variable];
    process.env[variable] = dir;
    let registrations = 0;
    const server = createServer((_request, response) => {
        registrations += 1;
        response.writeHead(201, { "content-type": "application/json" });
        response.end(
            JSON.stringify({ workspace_id: "workspace", worker_id: "worker", secret: "secret" }),
        );
    });
    try {
        const core = {
            server: `http://127.0.0.1:${await listen(server)}`,
            workspace: "acme",
            token: "owner",
        };
        const [first, second] = await Promise.all([
            identity(core, "test-box"),
            identity(core, "test-box"),
        ]);
        assert.equal(registrations, 1);
        assert.deepEqual(first, second);
    } finally {
        await new Promise((done) => server.close(done));
        if (previous === undefined) delete process.env[variable];
        else process.env[variable] = previous;
        await rm(dir, { recursive: true, force: true });
    }
});
test("saved Worker identities require a workspace when the server has several", async () => {
    const dir = await scratch("worker-identities");
    const variable = process.platform === "win32" ? "LOCALAPPDATA" : "XDG_STATE_HOME";
    const previous = process.env[variable];
    process.env[variable] = dir;
    const server = "https://gateway.example";
    const save = async (workspace) => {
        const identity = { server, workspace };
        const state = stateDir(server, workspace);
        await mkdir(state, { recursive: true });
        await writeFile(join(state, "identity.json"), JSON.stringify(identity));
        return identity;
    };
    try {
        assert.equal(await savedIdentity(server), null);
        const acme = await save("acme");
        assert.deepEqual(await savedIdentity(server), acme);
        const design = await save("design");
        await assert.rejects(
            savedIdentity(server),
            /Multiple saved Worker identities.*Specify --workspace/,
        );
        assert.deepEqual(await savedIdentity(server, "design"), design);
    } finally {
        if (previous === undefined) delete process.env[variable];
        else process.env[variable] = previous;
        await rm(dir, { recursive: true, force: true });
    }
});
const listen = async (server) => {
    await new Promise((done) => server.listen(0, "127.0.0.1", done));
    return server.address().port;
};

test("the systemd unit quotes its command and stops restarting a refused Worker", () => {
    const text = unit(
        "https://gateway.example",
        "acme",
        ["/opt/node dir/node", "/opt/fug/cli.js"],
        ["--service", '/x/100%"service'],
    );
    assert.match(
        text,
        /^ExecStart="\/opt\/node dir\/node" "\/opt\/fug\/cli.js" "worker" "--server" "https:\/\/gateway.example" "--workspace" "acme" "--service" "\/x\/100%%\\"service"$/m,
    );
    assert.match(text, /^RestartPreventExitStatus=2$/m);
    assert.match(text, /^Restart=on-failure$/m);
    assert.ok(
        unit("https://gateway.example", "acme", ["/opt/$node\n/bin"]).includes(
            "/opt/$$node\\n/bin",
        ),
    );
});

test("the Worker configuration names the relay, identity and machine budgets", () => {
    const config = configuration(
        {
            server: "https://g",
            workspace: "acme",
            workspace_id: "ws-1",
            worker_id: "worker_1",
            secret: "a".repeat(64),
            name: "box",
        },
        "127.0.0.1:4000",
        "/state",
    );
    assert.deepEqual(config, {
        gateway: "127.0.0.1:4000",
        worker_id: "worker_1",
        workspace_id: "ws-1",
        token: "a".repeat(64),
        name: "box",
        data_root: "/state/data",
        work_root: "/state/work",
        compute_threads: 8,
        parallel: 8,
        tools: {},
    });
    const custom = configuration({}, "", "/state", 3, { "fughetta-llvm": "/bin/llvm" });
    assert.equal(custom.compute_threads, 3);
    assert.equal(custom.parallel, 3);
    assert.deepEqual(custom.tools, { "fughetta-llvm": "/bin/llvm" });
});

test(
    "the release download checks its digests, caches the service with its hosts and reports an unavailable release list",
    { timeout: 30_000 },
    async () => {
        const dir = await scratch("release");
        const saved = process.env.XDG_CACHE_HOME;
        process.env.XDG_CACHE_HOME = dir;
        const body = Buffer.from("#!/bin/sh\necho service\n");
        const host = Buffer.from("#!/bin/sh\necho llvm\n");
        let digest = createHash("sha256").update(body).digest("hex");
        let downloads = 0;
        const suffix = `${process.platform}-${process.arch}${process.platform === "win32" ? ".exe" : ""}`;
        const name = `fughetta-service-${suffix}`;
        const llvm = `fughetta-llvm-${suffix}`;
        const server = createServer((req, res) => {
            const base = `http://127.0.0.1:${server.address().port}`;
            if (req.url === "/latest")
                res.end(
                    JSON.stringify({
                        tag_name: "v0.1.0",
                        assets: [
                            {
                                name,
                                browser_download_url: `${base}/download`,
                                digest: `sha256:${digest}`,
                            },
                            {
                                name: llvm,
                                browser_download_url: `${base}/llvm`,
                                digest: `sha256:${createHash("sha256").update(host).digest("hex")}`,
                            },
                        ],
                    }),
                );
            else {
                ++downloads;
                res.end(req.url === "/llvm" ? host : body);
            }
        });
        const url = `http://127.0.0.1:${await listen(server)}/latest`;
        const lines = [];
        try {
            digest = "0".repeat(64);
            await assert.rejects(
                service(url, (l) => lines.push(l)),
                /does not match its published digest/,
            );
            digest = createHash("sha256").update(body).digest("hex");
            const path = await service(url, (l) => lines.push(l));
            assert.equal(path, join(dir, "fughetta", "service", "v0.1.0", name));
            assert.deepEqual(await readFile(path), body);
            if (process.platform !== "win32") assert.equal((await stat(path)).mode & 0o777, 0o755);
            assert.deepEqual(await tools(path), { "fughetta-llvm": join(dirname(path), llvm) });
            assert.deepEqual(await readFile(join(dirname(path), llvm)), host);
            assert.equal(await service(url, (l) => lines.push(l)), path);
            assert.equal(downloads, 3, "a cached release is not downloaded again");
            await new Promise((resolve) => server.close(resolve));
            await assert.rejects(
                service(url, (l) => lines.push(l)),
                /release list is unavailable/,
            );
        } finally {
            server.close();
            if (saved === undefined) delete process.env.XDG_CACHE_HOME;
            else process.env.XDG_CACHE_HOME = saved;
            await rm(dir, { recursive: true, force: true });
        }
    },
);

// A stand-in for the hosted gateway: it lists one workspace for the token, forwards /w/acme to a trusted-mode core as an owner,
// and joins the Worker tunnel to the core's remote Worker listener.
const frontToken = "test-front-token";
const frontHeaders = { authorization: `Bearer ${frontToken}` };
const owner = {
    ...frontHeaders,
    "x-fughetta-workspace": "ws-acme",
    "x-fughetta-user": "owner",
    "x-fughetta-role": "owner",
};

function gateway(core, remote, seen) {
    const server = createServer((req, res) => {
        const auth = req.headers.authorization === "Bearer user-token";
        if (req.url === "/.well-known/oauth-authorization-server")
            return res.end(
                JSON.stringify({
                    authorization_endpoint: "http://127.0.0.1:1/authorize",
                    token_endpoint: "http://127.0.0.1:1/token",
                }),
            );
        if (!auth) return res.writeHead(401).end('{"message":"sign in"}');
        if (req.url === "/api/v1/workspaces") return res.end(JSON.stringify([{ name: "acme" }]));
        if (!req.url.startsWith("/w/acme/")) return res.writeHead(404).end();
        const forward = request(
            `${core}${req.url.slice("/w/acme".length)}`,
            {
                method: req.method,
                headers: {
                    "content-type": "application/json",
                    accept: req.headers.accept ?? "application/json",
                    ...owner,
                },
            },
            (reply) => {
                res.writeHead(reply.statusCode, reply.headers);
                reply.pipe(res);
            },
        );
        req.pipe(forward);
    });
    server.on("upgrade", (req, socket, head) => {
        seen.push({
            url: req.url,
            origin: req.headers.origin,
            protocol: req.headers["sec-websocket-protocol"],
        });
        if (req.method !== "GET" || req.url !== "/w/acme/workers/tunnel") {
            socket.end("HTTP/1.1 404 Not Found\r\nConnection: close\r\n\r\n");
            return;
        }
        const forward = request(`http://127.0.0.1:${remote}/workers/tunnel`, {
            method: "GET",
            headers: { ...req.headers, ...frontHeaders, host: `127.0.0.1:${remote}` },
        });
        forward.once("upgrade", (reply, upstream, upstreamHead) => {
            let response = `HTTP/${reply.httpVersion} ${reply.statusCode} ${reply.statusMessage}\r\n`;
            for (let i = 0; i < reply.rawHeaders.length; i += 2)
                response += `${reply.rawHeaders[i]}: ${reply.rawHeaders[i + 1]}\r\n`;
            socket.write(response + "\r\n");
            socket.write(upstreamHead);
            upstream.write(head);
            socket.pipe(upstream).pipe(socket);
            socket.once("close", () => upstream.destroy());
            upstream.once("close", () => socket.destroy());
            upstream.once("error", () => socket.destroy());
        });
        forward.once("response", (reply) => {
            socket.write(
                `HTTP/${reply.httpVersion} ${reply.statusCode} ${reply.statusMessage}\r\nConnection: close\r\n\r\n`,
            );
            reply.pipe(socket);
        });
        socket.once("close", () => forward.destroy());
        socket.once("error", () => socket.destroy());
        forward.once("error", () => socket.destroy());
        forward.end();
    });
    return server;
}

const systemd = process.platform === "linux" && process.env.FUGHETTA_TEST_SYSTEMD === "1";
const llvm = process.env.FUGHETTA_TEST_LLVM;
const receiptProject = {
    build_configurations: {
        native: {
            builders: {
                main: {
                    adapter: "command",
                    options: {
                        operations: {
                            build: {
                                argv: ["cc", "-c", "receipt.c", "-o", "receipt.o"],
                                outputs: { object: { type: "native-artifact", path: "receipt.o" } },
                            },
                        },
                    },
                },
            },
            tasks: { build: { builder: "main", operation: "build" } },
            operations: { build: { tasks: ["build"], exports: { object: "receipt.o" } } },
        },
    },
    default_configurations: ["native"],
    analysis: {
        native: {
            stages: {
                artifact: {
                    server: { provider: "native-artifact", options: { module: "receipt" } },
                    build_configuration: "native",
                    inputs: {
                        artifact: [{ configuration: "native", task: "build", output: "object" }],
                    },
                },
            },
            outputs: { native: [{ stage: "artifact", output: "facts" }] },
        },
    },
};

async function verifyExecutionReceipts(connection, workerId, history) {
    const args = { project: "receipt", worldline: "main" };
    const initial = await tool(connection, "worldline", { ...args, action: "inspect" });
    await tool(connection, "worldline", {
        ...args,
        action: "apply",
        observed: initial.version,
        operation_id: "receipt-fixture",
        changes: [{ kind: "create", path: "receipt.c", text: "int receipt(void) { return 42; }" }],
    });
    const build = await tool(connection, "build", args);
    assert.ok(build.ok, JSON.stringify(build));
    const [artifact] = build.results[0].artifact_receipts;
    const verifyReceipt = (audit, kind, snapshot) => {
        const claim = audit.submitted;
        assert.equal(claim.worker_id, workerId);
        assert.equal(claim.workspace_id, "ws-acme");
        assert.equal(claim.snapshot, snapshot);
        assert.equal(claim.subject_kind, kind);
        const fields = [
            "workspace_id",
            "worker_id",
            "snapshot",
            "recipe_digest",
            "subject_kind",
            "subject_id",
            "execution",
        ];
        const message = JSON.stringify([
            "fughetta/worker-execution-receipt",
            ...fields.map((key) => claim[key]),
        ]);
        const publicKey = createPublicKey({
            key: {
                kty: "OKP",
                crv: "Ed25519",
                x: Buffer.from(audit.public_key, "hex").toString("base64url"),
            },
            format: "jwk",
        });
        assert.ok(
            verify(null, Buffer.from(message), publicKey, Buffer.from(claim.signature, "hex")),
        );
    };
    const recorded = (await history()).find((row) =>
        row.artifact_receipts?.some(
            (audit) => audit.submitted.signature === artifact.submitted.signature,
        ),
    );
    assert.ok(recorded);
    assert.equal(recorded.version, build.revision);
    verifyReceipt(artifact, "artifact_manifest", recorded.snapshot);
    const [, exports] = JSON.parse(artifact.manifest);
    assert.ok(exports.some(({ path }) => path === "receipt.o"));
    const query = { ...args, action: "symbols", configuration: "native" };
    const published = await tool(connection, "language", query);
    assert.ok(
        published.view && published.items.some(({ name }) => name === "receipt"),
        JSON.stringify(published),
    );
    const audit = await tool(connection, "language", {
        ...query,
        view: published.view,
        execution_receipts: true,
    });
    assert.ok(audit.shard_receipts.length);
    for (const receipt of audit.shard_receipts) {
        assert.ok(receipt.published);
        assert.equal(receipt.public_key, artifact.public_key);
        verifyReceipt(
            receipt,
            "semantic_shard",
            audit.snapshots.find(({ project }) => project === "receipt").snapshot,
        );
    }
}

test(
    systemd
        ? "systemd installs, restarts, and removes a registered Worker"
        : "fug worker registers this machine, serves the workspace through the tunnel, and stops when revoked",
    { timeout: 120_000, skip: missingService },
    async () => {
        const dir = await scratch("worker");
        const http = await port(),
            remote = await port();
        const config = join(dir, "config.json");
        const workerBinary = llvm ? join(dir, "fughetta-service") : binary;
        if (llvm) {
            await symlink(resolve(binary), workerBinary);
            await symlink(
                resolve(llvm),
                join(dir, `fughetta-llvm-${process.platform}-${process.arch}`),
            );
        }
        await writeFile(
            config,
            JSON.stringify({
                runtime: { threads: 6, jobs: 1, workers: 0 },
                server: {
                    http_bind: "127.0.0.1",
                    http_port: http,
                    worker_port: await port(),
                    source: `127.0.0.1:${await port()}`,
                    remote_worker_port: remote,
                    remote_worker_enrollment: true,
                    storage: join(dir, "state"),
                    auth: { mode: "trusted", workspace: "ws-acme", front_token: frontToken },
                },
                projects: llvm ? { receipt: receiptProject } : {},
            }),
        );
        const core = spawn(binary, [config], { cwd: dir, stdio: ["ignore", "ignore", "inherit"] });
        const origin = `http://127.0.0.1:${http}`;
        const seen = [];
        const front = gateway(origin, remote, seen);
        const server = `http://127.0.0.1:${await listen(front)}`;
        const env = {
            ...process.env,
            HOME: dir,
            LOCALAPPDATA: dir,
            XDG_CONFIG_HOME: systemd
                ? process.env.XDG_CONFIG_HOME || join(process.env.HOME, ".config")
                : join(dir, "config"),
            XDG_STATE_HOME: join(dir, "state-home"),
            XDG_CACHE_HOME: join(dir, "cache"),
        };
        delete env.FUGHETTA_TOKEN;
        let worker;
        let installed = false;
        const ctl = (...args) => promisify(execFile)("systemctl", ["--user", ...args]);
        const workerArgs = (verb) => [
            cli,
            "worker",
            ...(verb ? [verb] : []),
            "--server",
            server,
            "--workspace",
            "acme",
        ];
        const runCli = (args) => promisify(execFile)(process.execPath, args, { cwd: dir, env });
        const serviceUnit = unitName(server, "acme");
        const waitOnline = async () => {
            for (let i = 0; i < 200; ++i) {
                const listed = await workers();
                if (listed.some((w) => w.online)) return listed;
                await delay(100);
            }
            throw new Error(`the Worker did not come online:
${stderr}`);
        };
        let stderr = "";
        const workers = async () =>
            (await (await fetch(`${origin}/api/v1/workers`, { headers: owner })).json()).filter(
                (w) => w.worker_id,
            );
        try {
            for (let i = 0; ; ++i) {
                try {
                    if ((await fetch(`${origin}/healthz`, { headers: frontHeaders })).ok) break;
                } catch {}
                if (i > 300) throw new Error("fughetta-service did not become ready");
                await delay(100);
            }
            await assert.rejects(
                promisify(execFile)(
                    process.execPath,
                    [
                        cli,
                        "worker",
                        "--server",
                        server,
                        "--workspace",
                        "acme",
                        "--token",
                        "user-token",
                        "--service",
                        dir,
                    ],
                    { cwd: dir, env },
                ),
                /Worker service must be a file/,
            );
            assert.deepEqual(await workers(), []);
            const options = [
                "--token",
                "user-token",
                "--name",
                "test-box",
                "--service",
                workerBinary,
                "--parallel",
                "2",
            ];
            let exited;
            if (systemd) {
                await assert.rejects(
                    stat(join(env.XDG_CONFIG_HOME, "systemd", "user", serviceUnit)),
                    { code: "ENOENT" },
                );
                installed = true;
                const install = await runCli([...workerArgs("install"), ...options]);
                stderr = install.stderr;
                assert.equal((await ctl("is-enabled", serviceUnit)).stdout.trim(), "enabled");
            } else {
                worker = spawn(process.execPath, [...workerArgs(""), ...options], {
                    cwd: dir,
                    env,
                    stdio: ["ignore", "ignore", "pipe"],
                });
                worker.stderr.on("data", (b) => {
                    stderr += b;
                });
                exited = new Promise((done) => worker.once("exit", (code) => done(code)));
            }
            const listed = await waitOnline();
            assert.equal(listed.length, 1);
            assert.equal(listed[0].name, "test-box");
            assert.match(
                stderr,
                new RegExp(`registered test-box as ${listed[0].worker_id} in acme`),
            );
            assert.ok(seen.length > 0, "the Worker did not open a tunnel");
            assert.ok(
                seen.every(
                    (s) =>
                        s.url === "/w/acme/workers/tunnel" &&
                        s.origin === undefined &&
                        s.protocol === "fughetta-worker.v1",
                ),
                JSON.stringify(seen),
            );
            const workerRoot =
                process.platform === "win32"
                    ? join(dir, "Fughetta", "workers")
                    : join(dir, "state-home", "fughetta", "workers");
            const state = join(
                workerRoot,
                `${new URL(server).host.replace(/[^a-zA-Z0-9.-]/g, "_")}-acme`,
            );
            const saved = JSON.parse(await readFile(join(state, "identity.json"), "utf8"));
            assert.equal(saved.worker_id, listed[0].worker_id);
            const { stdout } = await promisify(execFile)(
                process.execPath,
                [
                    cli,
                    "worker",
                    "status",
                    "--server",
                    server,
                    "--workspace",
                    "acme",
                    "--token",
                    "user-token",
                ],
                { cwd: dir, env },
            );
            assert.equal(stdout.trim(), `test-box (${saved.worker_id}) in acme is online`);
            if (process.platform !== "win32")
                assert.equal((await stat(join(state, "worker.json"))).mode & 0o777, 0o600);
            assert.ok(!stderr.includes(saved.secret), "the secret leaked into the log");

            if (systemd) {
                const pid = () =>
                    ctl("show", "--property=MainPID", "--value", serviceUnit).then(({ stdout }) =>
                        stdout.trim(),
                    );
                const before = await pid();
                await ctl("stop", serviceUnit);
                assert.equal(await pid(), "0");
                await ctl("start", serviceUnit);
                assert.notEqual(await pid(), before);
                assert.deepEqual(
                    (await waitOnline())
                        .filter(({ online }) => online)
                        .map(({ worker_id }) => worker_id),
                    [saved.worker_id],
                );
            }
            if (llvm) {
                await verifyExecutionReceipts(
                    { server, workspace: "acme", token: "user-token" },
                    saved.worker_id,
                    async () => (await fetch(`${origin}/api/v1/builds`, { headers: owner })).json(),
                );
            }
            if (systemd) {
                await runCli(workerArgs("uninstall"));
                installed = false;
                await assert.rejects(ctl("is-enabled", serviceUnit));
                await assert.rejects(
                    stat(join(env.XDG_CONFIG_HOME, "systemd", "user", serviceUnit)),
                    { code: "ENOENT" },
                );
                assert.equal((await workers())[0].worker_id, saved.worker_id);
                return;
            }
            assert.equal(
                (
                    await fetch(`${origin}/api/v1/workers/${saved.worker_id}`, {
                        method: "DELETE",
                        headers: owner,
                    })
                ).status,
                200,
            );
            assert.equal(
                await Promise.race([exited, delay(20_000, "timeout", { ref: false })]),
                2,
                stderr,
            );
            assert.match(stderr, /refused this machine's identity/);
            await assert.rejects(stat(join(state, "identity.json")), { code: "ENOENT" });
        } finally {
            if (installed) await runCli(workerArgs("uninstall")).catch(() => {});
            worker?.kill("SIGTERM");
            front.close();
            core.kill("SIGTERM");
            await new Promise((done) =>
                core.exitCode !== null ? done() : core.once("exit", done),
            );
            await rm(dir, { recursive: true, force: true });
        }
    },
);
