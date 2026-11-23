# Fughetta CLI

`fug` connects a local repository to Fughetta so a coding agent can build, test,
run, and analyze its files on a core. Requires Node.js 22 or later.

## Install

```sh
bun add --global @fantasticfugue/fughetta-cli
```

For source builds, see the [repository guide](AGENTS.md#build-and-test).

## Connect a repository

For Fughetta hosting, run this in the repository you want to send:

```sh
fug init
```

The default origin is `https://gateway.fughetta.dev`. With no usable token, `fug` opens
sign-in in your browser and also prints the URL. Sign-in uses authorization code
with PKCE and a temporary listener on `127.0.0.1`; it expires after five minutes.
The token is saved for that origin. A single workspace is selected automatically.
For several workspaces, select one at the terminal prompt or supply its name:

```sh
fug init --server https://gateway.fughetta.dev --workspace my-team --name my-project
```

Noninteractive sessions must supply `--workspace` when several choices exist.
If your account has none, create a workspace in the console first.

For a self-hosted core, use its origin and a token issued by its owner:

```sh
fug init --server http://127.0.0.1:8080 --token '<core-token>'
```

A core has no workspace prefix or browser sign-in. Hosted requests use
`/w/{workspace}`. Remote origins require HTTPS. Plain HTTP is available on
`localhost`, `127.0.0.1`, and `[::1]` for local cores.
`FUGHETTA_CA_FILE` selects a PEM certificate authority file for HTTPS.

`init` uses an existing project or creates one. The project name defaults to the
directory name. When the project has no build configurations yet, `init` reads the
repository's manifests and writes the graphs they already describe, so the first
`fug build` and `language` call need no setup by the agent:

| Manifest found | Build configuration | Analysis stage |
| --- | --- | --- |
| `CMakeLists.txt` or `CMakePresets.json` | `debug` from the project's debug preset, else Ninja `build/debug` | `cpp` (clice) |
| `build.gradle`, `build.gradle.kts`, `settings.gradle` or `settings.gradle.kts` | `jvm` (Gradle model export) | `jvm` (kotlin) |
| a `.sln` or `.slnx` naming, or a checkout holding, `.fsproj` | `dotnet` (MSBuild restore and model) | `dotnet` (fsharp) |
| `pyproject.toml` with a `[project]`, `[tool.poetry]`, `[tool.pdm]` or `[build-system]` table | `python` (uv environment) | Syntax outline |

Each configuration has a `test` operation when the toolchain has one (CTest,
Gradle `test`, `dotnet test` for a test project, pytest when declared). The stages
share one `main` analysis profile, the one `fug language` uses when the
project names a single profile. Build directories the project does not ignore yet
are recorded in `.fughetta/ignore` so their output is never sent; for .NET these
are the `bin/` and `obj/` beside each project file, and a `bin/` elsewhere stays in
the source. A `vcpkg.json` without a toolchain file is reported, because configure
fails without one. Existing configurations are never replaced: rerunning `init`
keeps them and says so. A project the detection does not recognize stays without configurations,
and the agent sets them up with `schema`, `project`, and `save_project`.

`init` writes three things in the project: its own `.fughetta/` directory, which
holds the binding in `project.json`, and the registration of the MCP server where
Claude Code (`.mcp.json`) and Codex (`.codex/config.toml`) read it. It creates and
edits no ignore file, skill or command file of yours. The server itself tells the
agent how to work with it and offers the `sync`, `build`, `test`, `language` and
`worldline` prompts, which a client that lists MCP prompts shows as its own
commands. Other entries in the two registration files are preserved; malformed JSON
is left for manual editing. Start your coding agent in the repository after
initialization. The
registration uses `fug` when available on PATH; a source checkout otherwise records
absolute Node and CLI paths. Install `fug` on PATH and rerun `init` before sharing
that file.

## Commands

Local synchronization time is measured during checkout scanning, upload and writeback, excluding time waiting for the push lock. `push --json` returns `client_sync_seconds`; execution calls send it as `fughetta/client_sync_seconds` in MCP `_meta`, and results return it only in `timings.client_sync_seconds`. The service records this client-reported value beside its queue, dependency, worker sync and execution times for Insights. Human-readable execution results show the measured stages, including the worker total and its environment preparation and commands/analysis sub-stages.

`fug status`, `push`, `build`, `test`, `run`, `language`, `resolve`, and `clean` accept `--text` (the default) or `--json`. `worldline` and `d-mail` accept both switches and default to JSON; `help` also accepts both. Choose one output mode. JSON errors contain `code` and `message` on stderr; service refusals preserve their business code (such as `scope_locked` or `stale_frontier`), while local failures use categories such as `context_required`, `unauthenticated`, `invalid_params`, `missing_objects`, `permission_denied`, `conflict`, `connection_failed`, and `timeout`. HTTP errors without a business code use `http_STATUS`; unexpected failures use `internal_error`. Progress remains on stderr. Exit status is 0 for success, 1 for failure, 2 for an unknown command, and 130 for a cancelled execution.

Use `fug language definitions --path src/main.cpp --symbol render` or the same
arguments with `references` to query a symbol. Returned locations use one-based
lines and Unicode scalar columns. `fug language schema --json` reads the service's
shared semantic contracts. `fug language describe --provider ID` displays a
provider's operations, facts and typed ports, including configured external helpers.
Use `fug language inspect --symbol render` to discover
candidates, then `fug language inspect --view VIEW --entity SYMBOL --include type,scope`
to query the selected declaration. Search results include persistent symbol IDs,
contexts and a fixed view. `--limit` and `--cursor` continue pages of that view.
Use `--context CONTEXT` with `--entity` to select a candidate's compilation context.
Text output displays structured signatures, type qualifiers and declaration locations.
Template applications retain ordered type/value arguments, declaration IDs, null pointers and nested parameter packs.
Inspection also displays declaration visibility, modifiers, attributes and parameter
names/defaults. Add `--include declarations` to other queries to request these details.

Use `fug language relations --view VIEW --entity SYMBOL --relations aliases,overrides --direction outgoing --depth 2`
to follow declaration relationships. Relation results retain intermediate entities,
reference roles and source locations; `--direction incoming` finds incoming edges.
Use `fug language impact --view VIEW --entity SYMBOL --changes body --depth 4`
to trace potential behavior changes through callers, bindings and source/artifact
mappings. `--changes declaration` also follows declaration references; omitting
the flag includes both categories. Text and JSON results retain path evidence.
Use `fug language impact --from-view BEFORE --to-view AFTER --depth 4` to classify
changes and trace paths in both fixed views, including deleted declarations.
Comparison pages contain changed entities; path evidence identifies its source view.
Fixed-view comparisons skip source synchronization.
For another page, preserve the action, selector, filters and limit, use the returned
view, and pass the decoded cursor string as one argument. Failed queries and expired
views exit with status 1; the response remains available in text and JSON output.
Select a profile's outputs with `--configuration NAME --outputs primary,combined`.
`fug language plan --configuration NAME --outputs primary` displays the selected
stage graph. `--budget-nodes`, `--budget-units` and `--budget-ms` accept nonnegative
integers for query and analysis work; configured limits still apply.

Partial results display their missing coverage and a continuation token. Use
`fug language --continuation TOKEN --budget-nodes 2000` to continue the stored
query, passing the decoded token string as one argument. Only budget overrides
accompany a continuation; the token selects its source, profile and query.
Analysis can return a new `next_view`; use the returned `view` and cursor for
subsequent pages. For comparison pages, retain both `--from-view` and `--to-view`
and add `--cursor`; a separate `--view` is unnecessary. Plan, schema, describe,
fixed-view and continuation requests skip source synchronization in both the CLI
and MCP proxy.

| Command | Purpose |
| --- | --- |
| `fug init [--server URL] [--workspace NAME] [--name PROJECT] [--token TOKEN]` | Bind, configure, send files, and register MCP |
| `fug login [--server URL] [--workspace NAME] [--token TOKEN]` | Sign in and save a token for an origin |
| `fug push` | Send local changes to the bound project |
| `fug status` | Show the binding, cache use, pending recovery, and available build configurations |
| `fug resolve` | List synchronization recovery copies and recovery guidance |
| `fug clean` | Remove old delivered logs and artifacts |
| `fug build [CONFIGURATION ...]` | Synchronize and build on workspace workers |
| `fug test [CONFIGURATION ...]` | Synchronize and run remote tests |
| `fug run CONFIGURATION` | Synchronize and execute a saved run configuration |
| `fug mcp` | Serve newline-delimited MCP JSON on stdin/stdout |
| `fug worker [install] [--server URL] [--workspace NAME] [--name MACHINE] [--parallel N] [--service PATH] [--token TOKEN]` | Serve the workspace's builds on this machine; `install` keeps it running as a systemd user service |
| `fug worker uninstall [--server URL] --workspace NAME` | Remove that service |
| `fug --help` | Show usage |

`push`, `status`, and `mcp` find the nearest binding in the current directory or
its parents. Tokens are selected in this order: `--token`, `FUGHETTA_TOKEN`, saved
token. Credentials live in `$XDG_CONFIG_HOME/fughetta/credentials.json`, or
`~/.config/fughetta/credentials.json` when XDG configuration is unset. Windows uses
`%APPDATA%\Fughetta\credentials.json`. Credential writes are serialized and use
mode 0600 on POSIX. Bindings and MCP registration contain no token.

## Explicit worldlines

`fug worldline list` lists the project's worldlines. `fug worldline fork NAME`
synchronizes the current copy and forks its resulting version. It retains the
request locally; retry the same command after a lost reply to recover the same
fork. The current directory stays on its original worldline.

Use `fug worldline checkout NAME NEW_DIRECTORY` to download a worldline into a
new directory outside the current checkout. Existing directories are refused.
Each copy has its own baseline and pending-operation records. After an interrupted
download, run `fug push` from the new directory to resume synchronization. Run
`fug mcp` there to use the branch's engineering tools.

`fug worldline diff SOURCE [--version VERSION] [--observed VERSION]` compares
that source version with the bound target worldline's observed version. Omitted
versions select current server heads. Output includes both versions and changed
file metadata; it does not synchronize the local directory.

`fug worldline promote SOURCE --operation-id ID [--version VERSION]
[--observed VERSION] [--intent TEXT]` copies the source changes since the common
history into one atomic target contribution. Unrelated target changes remain;
a file changed differently in both worldlines refuses the whole operation.
The command saves both selected versions before publishing. After a lost reply,
repeat the same operation ID and arguments to recover its receipt, even if heads
have advanced. Use a new ID for another promotion. Run `fug push` afterward to
synchronize the target checkout; local edits use the usual conflict recovery.

Named checkpoints select a fixed server version:

```sh
fug worldline tag reviewed --version VERSION --operation-id review-1 --intent "Reviewed parser"
fug worldline references
fug worldline channel stable --version @reviewed --operation-id stable-1
fug worldline channel stable --version NEXT_VERSION --expected reference:2 --operation-id stable-2
fug worldline reference-history
fug worldline receipt stable-2
fug build debug --version @reviewed
fug test debug --version @reviewed
fug run app --version @reviewed
fug worldline checkout @reviewed ../reviewed-copy
```

Tags are immutable. Moving a channel requires its current receipt from
`references` as `--expected`. Repeat the same operation ID and arguments to
recover a lost response. `--attestations FILE` on tag/channel reads an array of
`{ "kind": "review", "receipt": "review-42", "conclusion": "Approved" }` records;
`build` and `test` are also accepted kinds. The service records these as the
caller's statements alongside the authenticated actor.

`--version` on build/test/run resolves the selected server source without pushing
the local directory. A checkpoint checkout verifies each file's size and SHA-256
digest against the selected manifest before writing it. The binding records the
resolved version for read-only access and execution.
`fug push` refuses a pinned checkout. To edit it, run `fug worldline fork NAME`
there, then check out that new worldline in another directory. The alternate
checkout spelling is `fug worldline checkout LINE NEW_DIRECTORY --version @TAG`.

Worldline histories remain separate. Use `fug d-mail send --to RECIPIENT --file FILE`
to exchange conclusions between branches.

## Run builds on your own machine

A workspace owner can make a Linux, Windows, or macOS machine serve the workspace's builds:

```sh
fug worker --workspace my-team
```

On first use `fug` signs in, registers the machine (named after its host name,
or `--name MACHINE`), and saves its identity in
`$XDG_STATE_HOME/fughetta/workers/<host>-<workspace>/identity.json` (mode 0600 on Unix;
`~/.local/state` when unset, `%LOCALAPPDATA%\Fughetta\workers` with an owner-only ACL on Windows).
Later starts reuse it without a token. `fug` then downloads the latest
`fughetta-service` release from GitHub for this platform, together with
`fughetta-llvm`, the host native artifact stages run. It checks their published
SHA-256 digests and caches them under `$XDG_CACHE_HOME/fughetta/service/<tag>/`.
The Worker configuration maps the `fughetta-llvm` tool to the cached host.
For offline use, select a binary with `--service PATH` or `FUGHETTA_SERVICE`. A
`fughetta-llvm-<platform>-<arch>` beside it is mapped the same way.

The Worker connects only outward. `fug` listens on a loopback port and relays
each Worker connection to the gateway over WebSocket, using the same origin and
`FUGHETTA_CA_FILE` as other commands. `fug` starts the Worker directly;
foreground execution requires no systemd user session. The deployment supplies
the execution environment and isolation. `fug` restarts a Worker that exits. When an owner revokes the
machine in the console, the Worker stops, `fug` exits with status 2 and removes
the saved identity; run `fug worker` again to register the machine anew.

```sh
fug worker install --workspace my-team     # start now and at every sign-in
fug worker status --workspace my-team      # report the registered machine’s connection state
loginctl enable-linger "$USER"             # keep it running while signed out
fug worker uninstall --workspace my-team
```

Workers default to 8 compute threads and build parallelism of 8. Use
`fug worker --parallel 4` to set both budgets to 4. The value must be a positive
integer; `fug worker install --parallel 4` saves it in the systemd unit.

`install` registers the machine and downloads the release if needed, then writes
the systemd user unit `fughetta-worker-<host>-<workspace>.service`, which runs
`fug worker` with absolute paths, restarts it after failures, and does not
restart it after a revocation. Follow it with `journalctl --user -u <unit> -f`.
`uninstall` stops and removes the unit; the machine stays registered until an
owner revokes it.

## Files sent to the core

Fughetta receives file paths, contents, and executable bits. Text and binary
files are sent; each file must fit the core's configured size limit. Nested
`.gitignore` and `.fughettaignore` rules control selection, together with the
generated directories `init` recorded in `.fughetta/ignore`. Version control data,
`node_modules/`, and the root `.fughetta/` directory are excluded. Links, special
files, oversized files, and names refused by the core are skipped and reported.
Use ignore rules to exclude secrets before initialization.

`.fughetta/state/` holds local scan and push state and is ignored by Git. A push
tracks files this checkout sent; remote files it never had remain in place and
are reported as kept. See the sync implementation and its tests for conflict and
interrupted-push behavior.

Engineering tool results include a synchronization report with updated local
paths, deferred edits, source conflicts, and preserved content locations.
Baseline bytes come from the working tree while it still has the recorded digest
and otherwise from the saved remote version; the checkout keeps no second copy.
A running `fug mcp` holds the contents it last sent or received in memory, so
repeated edits to a file read nothing back.
Captured files in `state/recovered/` are checked on the next sync: unchanged
copies are removed, while copies changed through an editor's old file handle
remain available.

## Tools available to the agent

| Endpoint | Tools |
| --- | --- |
| Core | `configurations`, `build`, `test`, `run`, `language` |
| Project configuration | `project`, `save_project`, `effective`, `schema` |

The proxy binds project and worldline to the checkout. `build`, `test`, `run`,
and `language` expose an optional `version`, including names such as `@reviewed`.
Only the bound top-level `project` and `worldline` input fields are hidden from
tool schemas; nested configuration fields and result project attribution are retained.
A supplied version takes precedence over the checkout's pinned version; either
selection goes directly to the core without sending local changes. In a writable
checkout without a selected version, the proxy sends local changes before
`configurations`, `build`, `test`, `run`, and `language`; source tools use the
version returned by that send. A pinned checkout also lists configurations
without sending files. The agent edits local files with its own editor tools.
If sending fails, the tool returns an error without running the remote call.
Sync summaries and skipped or kept files go to stderr; stdout contains only MCP
messages. Calls run concurrently, use separate remote request IDs, and forward
cancellation to the correct endpoint. Cancellation also interrupts source sync.
Long calls stream progress and return the final result in the original call; no
polling is needed. Language queries prepare missing or stale analysis automatically.
Without an analysis configuration, `language` with `action: "inspect"` returns
a Tree-sitter outline of names, kinds, and source ranges. Use a file scope or
name selector to narrow the result. A semantic view requires an analysis configuration.

## License

Mozilla Public License 2.0. See [LICENSE](LICENSE).

## Sync recovery files

`fug status` shows local cache sizes and pending recovery even without a token or server connection. Remote lookup failures appear as `Remote status unavailable` in text or `remote_error` in JSON; unavailable `build_configurations` are omitted. Local inspection succeeds with exit status 0. `fug resolve --json` lists each saved copy with its original path, version where available, and recovery guidance. After recovering your edits, remove the saved copies you no longer need.

`fug clean` removes delivered logs and downloaded artifacts older than ten minutes. Active deliveries, recent files, and recovery copies stay. It reports freed bytes and remaining report/artifact sizes; `--json` returns those values as numbers.

The baseline stores file metadata and observed versions. Baseline bytes come
from the working tree while it still has the recorded digest and otherwise from
the worldline version saved for that path; unchanged files are not downloaded
again. Small writeback records in `state/pulls/` let the next sync finish an
interrupted installation without treating later local edits as the old baseline.

Before replacing or removing an existing file, sync moves it into
`state/recovered/`. It installs new content only if no editor has recreated the
target. The saved file and its JSON record retain the original path and versions;
they are recovery data, not build output. Sync reports saved paths on stderr.
Concurrent path creation also preserves the remote original under
`state/collisions/` before rebasing the local change. CRDT conflict projections
preserve differing local bytes under `state/conflicts/`.

Changing an existing copy's project or worldline binding is refused. Use a new
worldline checkout, which keeps pending operations separate. Older `sent.json`
ledgers are preserved and refused; sync does not guess their source baselines.

## D-mail

Send a text record from the bound worldline to a named recipient without merging
source between worldlines:

```sh
fug d-mail send --to branch-b --file findings.txt
fug d-mail read --to branch-b --after 0 --output inbox.json
```

Messages retain the authenticated sender, source worldline, recipient, timestamp,
and body. Recipients are labels within the project, not private mailboxes; project
members can read them. The default read recipient is the bound worldline name.
Reads return a cursor and `more` flag. Sending saves a local draft first; after a
lost response, reuse the printed `--operation-id` with the same file to retrieve
the existing message without sending it twice. Drafts remain under
`.fughetta/state/d-mail/`.

### Local execution logs

When a build, test, or run returns more than 8 KiB of step output, `fug` saves
that captured output in private files under `.fughetta/state/reports/execution-*/`.
Each step returns `output_file` (an absolute local path), `output_bytes`, and
`output_shortened`, alongside a short tail in `output`. Diagnostics, test results,
and exit status remain in the result. The existing `truncated` field describes the inline worker summary. A step
with a `log` reference also downloads the separately captured process output,
including bytes omitted from that summary, and exposes it as `output_file` when
capture is complete. `log_truncated` indicates that the 64 MiB per-configuration
log storage budget was exhausted. In that case `log.local_path` holds the captured
prefix, while the inline tail is kept separately; if shortened, its complete copy
is saved as `output_file`. `log_error` reports worker log storage failures. If local storage fails, the complete received result remains
available and a `delivery_error` describes the failure. Each call uses a separate
report directory. Delivery directories are temporary and excluded from source sync.
Copy logs or artifacts outside `.fughetta/state` if they need permanent retention.

### Downloaded artifacts

Build, test, and run results can include `exports`. `fug` downloads each file to
`.fughetta/state/artifacts/execution-*/`, checks its SHA-256 digest and size, and
adds an absolute `local_path` to the result. Executable files retain execution
permission. Later calls reuse a delivered file after checking its digest, size,
and execution permission. Reuse is scoped to the bound service, workspace, and
project. Modified files are kept; a replacement download gets a new path.
Downloads use project-authorized URLs from the bound gateway;
remote filenames cannot select paths outside this new artifact directory.
A failed download adds `delivery_error` to that file and removes its partial
local copy while preserving the build result and any other completed downloads.

On delivery calls, `fug` collects historical artifact and report directories at
most once a minute. Each category has a seven-day retention period and soft
limits of 20 GiB and 256 execution directories. Oldest eligible directories are
removed first. Active writers and directories used or modified in the last ten
minutes are protected, so temporary usage can exceed these limits. Successful
reuse refreshes a directory's retention time. Stale download-index entries are
removed with their missing files. Collection errors do not discard tool results.
