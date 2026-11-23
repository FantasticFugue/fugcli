// What `fug init` configures: the build, test and analysis graphs the checkout's manifests already describe.
// Detection is deterministic: the same files always produce the same settings, and nothing is executed.
import { lstat, readdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { call, responseError, type Connection } from "./remote.js";
import { generated as rulesFile, Rules } from "./checkout/ignore.js";
import { object } from "./files.js";
import { normalizeName } from "./names.js";

type Settings = Record<string, unknown>;
interface Setup {
    // One line per detected toolchain and per warning, in the order they were found.
    summary: string[];
    // The project settings to save; it holds only the fields the detection generated.
    value: Settings;
    // The generated directories to record in .fughetta/ignore once the settings are saved.
    ignored: string[];
}

interface Builds {
    builders: Record<string, unknown>;
    tasks: Record<string, unknown>;
    operations: Record<string, unknown>;
    outputs: Record<string, unknown>;
}

const exists = (path: string) =>
    lstat(path).then(
        () => true,
        (error) => {
            if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
            throw error;
        },
    );

async function text(path: string): Promise<string | undefined> {
    try {
        return await readFile(path, "utf8");
    } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
        throw error;
    }
}

async function names(root: string, match: RegExp): Promise<string[]> {
    return (await readdir(root).catch(() => [] as string[]))
        .filter((name) => match.test(name))
        .sort();
}

const sorted = <T>(value: Record<string, T>) =>
    Object.fromEntries(Object.entries(value).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)));

// The CMake configure preset the configuration asks CMake for: a debug preset when the project names one, else the first
// visible preset in file order. A hidden preset cannot be selected, so it is never chosen.
function preferredPreset(manifest: unknown): string | undefined {
    if (!object(manifest)) return undefined;
    const presets = Array.isArray(manifest.configurePresets) ? manifest.configurePresets : [];
    const named = presets.filter(
        (preset): preset is { name: string; hidden?: boolean } =>
            object(preset) && typeof preset.name === "string" && preset.name.length > 0,
    );
    const visible = named.filter((preset) => preset.hidden !== true);
    for (const want of ["debug", "dev", "development"]) {
        const found = visible.find((preset) => preset.name.toLowerCase() === want);
        if (found) return found.name;
    }
    return visible[0]?.name;
}

async function readJson(path: string): Promise<unknown> {
    const content = await text(path);
    if (content === undefined) return undefined;
    try {
        return JSON.parse(content);
    } catch {
        return undefined;
    }
}

// The toolchain file a configure preset resolves through its `inherits` chain, if any.
function presetToolchain(manifest: unknown, name: string): string | undefined {
    if (!object(manifest) || !Array.isArray(manifest.configurePresets)) return undefined;
    const presets = new Map<string, Record<string, unknown>>();
    for (const preset of manifest.configurePresets)
        if (object(preset) && typeof preset.name === "string") presets.set(preset.name, preset);
    const seen = new Set<string>();
    const resolve = (current: Record<string, unknown> | undefined): string | undefined => {
        if (!current) return undefined;
        const key = typeof current.name === "string" ? current.name : "";
        if (key) {
            if (seen.has(key)) return undefined;
            seen.add(key);
        }
        if (typeof current.toolchainFile === "string" && current.toolchainFile)
            return current.toolchainFile;
        const parents =
            typeof current.inherits === "string"
                ? [current.inherits]
                : Array.isArray(current.inherits)
                  ? current.inherits.filter(
                        (parent): parent is string => typeof parent === "string",
                    )
                  : [];
        for (const parent of parents) {
            const found = resolve(presets.get(parent));
            if (found) return found;
        }
        return undefined;
    };
    return resolve(presets.get(name));
}

function cmake(
    buildDirectory: string,
    preset: string | undefined,
    toolchain: string | undefined,
): Builds {
    return {
        builders: {
            main: {
                adapter: "cmake",
                options: {
                    build_dir: buildDirectory,
                    export_compile_commands: true,
                    ...(preset ? { preset } : { generator: "Ninja", build_type: "Debug" }),
                    ...(toolchain ? { toolchain_file: toolchain } : {}),
                },
            },
        },
        tasks: {
            configure: { builder: "main", operation: "configure" },
            build: { builder: "main", operation: "build", after: ["configure"] },
            test: { builder: "main", operation: "test", after: ["build"] },
        },
        operations: { build: { tasks: ["build"] }, test: { tasks: ["test"] } },
        outputs: { database: { task: "configure", output: "compilation_database" } },
    };
}

function gradle(): Builds {
    const dependencies = { dependencies: { task: "dependencies", output: "dependencies" } };
    return {
        builders: {
            gradle: {
                adapter: "gradle",
                options: { source_dir: ".", model_dir: "build/fughetta/gradle" },
            },
        },
        tasks: {
            dependencies: { builder: "gradle", operation: "prepare" },
            model: { builder: "gradle", operation: "model", inputs: dependencies },
            compile: { builder: "gradle", operation: "compile", inputs: dependencies },
            test: {
                builder: "gradle",
                operation: "compile",
                inputs: dependencies,
                parameters: { targets: ["test"] },
            },
        },
        operations: { build: { tasks: ["compile"] }, test: { tasks: ["test"] } },
        outputs: { model: { task: "model", output: "model" } },
    };
}

function msbuild(projects: string[], testProject: string | undefined): Builds {
    const assets = { assets: { task: "restore", output: "assets" } };
    return {
        builders: {
            dotnet: {
                adapter: "msbuild",
                options: {
                    projects,
                    model_dir: "build/fughetta/msbuild",
                    properties: { Configuration: "Debug" },
                },
            },
            ...(testProject
                ? {
                      "dotnet-test": {
                          adapter: "command",
                          options: {
                              operations: {
                                  test: { argv: ["dotnet", "test", testProject], working_dir: "." },
                              },
                          },
                      },
                  }
                : {}),
        },
        tasks: {
            restore: { builder: "dotnet", operation: "restore" },
            model: { builder: "dotnet", operation: "model", inputs: assets },
            compile: { builder: "dotnet", operation: "compile", inputs: assets },
            ...(testProject
                ? { test: { builder: "dotnet-test", operation: "test", after: ["compile"] } }
                : {}),
        },
        operations: {
            build: { tasks: ["compile"] },
            ...(testProject ? { test: { tasks: ["test"] } } : {}),
        },
        outputs: { model: { task: "model", output: "model" } },
    };
}

function python(test: boolean): Builds {
    return {
        builders: {
            uv: {
                adapter: "uv",
                options: {
                    project_dir: ".",
                    env_dir: ".venv",
                    build_dir: "dist",
                    ...(test ? { run_command: ["pytest"] } : {}),
                },
            },
        },
        tasks: {
            lock: { builder: "uv", operation: "lock" },
            sync: { builder: "uv", operation: "sync", after: ["lock"] },
            ...(test ? { test: { builder: "uv", operation: "run", after: ["sync"] } } : {}),
        },
        operations: {
            build: { tasks: ["sync"] },
            ...(test ? { test: { tasks: ["test"] } } : {}),
        },
        outputs: { environment: { task: "sync", output: "python_environment" } },
    };
}

// The project files of a solution, as paths relative to the checkout. A classic solution lists them in Project entries; the XML
// solutions (.slnx) name them as path attributes below Project, Folder and File elements.
function solutionProjects(content: string): string[] {
    const paths = content.trimStart().startsWith("<")
        ? [...content.matchAll(/<Project\b[^>]*?\s[Pp]ath\s*=\s*"([^"]+)"/g)].map(
              (match) => match[1]!,
          )
        : [...content.matchAll(/^Project\("[^"]*"\)\s*=\s*"[^"]*",\s*"([^"]+)"/gm)].map(
              (match) => match[1]!,
          );
    return paths
        .map((project) => project.replaceAll("\\", "/"))
        .filter((project) => /\.(fs|cs|vb)proj$/i.test(project))
        .sort();
}

// The generated directories the project search does not enter, besides those the checkout's ignore rules exclude.
const generated = new Set(["bin", "obj", "build", "node_modules"]);

// The .NET projects a configuration builds and the one a test command runs: the solution's project list when it names F# projects,
// else the F# project files anywhere in the source.
async function dotnet(root: string): Promise<{ projects: string[]; test?: string }> {
    for (const name of await names(root, /\.(sln|slnx)$/i)) {
        const projects = solutionProjects((await text(join(root, name))) ?? "");
        if (projects.some((project) => /\.fsproj$/i.test(project)))
            return { projects, test: await testProject(root, projects) };
    }
    const found: string[] = [];
    // Each directory is tested with the rules of the ignore files above it, and entered with its own.
    const walk = async (dir: string, relative: string, rules: Rules): Promise<void> => {
        for (const name of await names(dir, /./)) {
            const path = relative ? `${relative}/${name}` : name;
            const full = join(dir, name);
            if (!(await lstat(full)).isDirectory()) {
                if (/\.fsproj$/i.test(name)) found.push(path);
                continue;
            }
            if (generated.has(name) || rules.ignored(path, true)) continue;
            await walk(full, path, await rules.enter(full, path));
        }
    };
    await walk(root, "", await Rules.root().enter(root, ""));
    const projects = found.sort();
    if (!projects.length) return { projects: [] };
    return { projects, test: await testProject(root, projects) };
}

async function testProject(root: string, projects: string[]): Promise<string | undefined> {
    for (const project of projects) {
        const content = (await text(join(root, project))) ?? "";
        if (content.includes("Microsoft.NET.Test.Sdk")) return project;
    }
    return undefined;
}

// The generated directories the checkout must not send and does not ignore yet. A name that starts with a slash is one
// directory from the root; any other matches at every depth.
async function unignored(root: string, directories: string[]): Promise<string[]> {
    const rules = await Rules.root().enter(root, "");
    return directories.filter((directory) => !rules.ignored(directory.replace(/^\//, ""), true));
}

// Keeps generated output out of the source by recording the directories in this checkout's own rules; the project's ignore
// files stay as their authors wrote them.
async function ignore(root: string, directories: string[]): Promise<void> {
    if (!directories.length) return;
    const file = join(root, rulesFile);
    const existing = (await text(file)) ?? "";
    const head = existing && !existing.endsWith("\n") ? `${existing}\n` : existing;
    await writeFile(file, `${head}${directories.map((directory) => `${directory}/`).join("\n")}\n`);
}

// Reads the checkout's manifests and returns the project settings that build, test and analyze it.
export async function detect(root: string): Promise<Setup | undefined> {
    const summary: string[] = [];
    const builds: Record<string, Builds> = {};
    const stages: Record<string, unknown> = {};
    const ignored: string[] = [];
    const warnings: string[] = [];

    if (
        (await exists(join(root, "CMakeLists.txt"))) ||
        (await exists(join(root, "CMakePresets.json")))
    ) {
        const manifest = (await exists(join(root, "CMakePresets.json")))
            ? await readJson(join(root, "CMakePresets.json"))
            : undefined;
        const preset = preferredPreset(manifest);
        const name = normalizeName(preset ?? "debug", "debug");
        const buildDirectory = `build/${name}`;
        // A vcpkg manifest needs a toolchain file. A preset owns its choice; a checkout that vendors vcpkg supplies its own.
        const vendored = "vcpkg/scripts/buildsystems/vcpkg.cmake";
        const manifestMode = await exists(join(root, "vcpkg.json"));
        const presetOwns = (preset && presetToolchain(manifest, preset)) || undefined;
        const toolchain =
            manifestMode && !presetOwns && (await exists(join(root, vendored)))
                ? vendored
                : undefined;
        builds[name] = cmake(buildDirectory, preset, toolchain);
        stages.cpp = {
            server: { provider: "clice" },
            build_configuration: name,
            inputs: {
                compilation_database: [
                    { configuration: name, task: "configure", output: "compilation_database" },
                ],
            },
        };
        ignored.push(buildDirectory);
        summary.push(
            `Configured CMake${preset ? ` preset ${preset}` : ""} as build configuration ${name} and analysis stage cpp (clice)${toolchain ? ` with the vendored vcpkg toolchain ${toolchain}` : ""}`,
        );
        // Manifest mode needs a toolchain file at configure time; without one the build fails there.
        if (manifestMode && !presetOwns && !toolchain)
            warnings.push(
                "vcpkg.json is present, but no toolchain file is available: add vcpkg/scripts/buildsystems/vcpkg.cmake or set toolchain_file so the configuration can configure",
            );
    }

    if (
        (await exists(join(root, "build.gradle.kts"))) ||
        (await exists(join(root, "build.gradle"))) ||
        (await exists(join(root, "settings.gradle.kts"))) ||
        (await exists(join(root, "settings.gradle")))
    ) {
        builds.jvm = gradle();
        stages.jvm = {
            server: { provider: "kotlin" },
            build_configuration: "jvm",
            inputs: { project_model: [{ configuration: "jvm", task: "model", output: "model" }] },
        };
        ignored.push("build");
        summary.push(
            "Configured Gradle as build configuration jvm and analysis stage jvm (kotlin)",
        );
    }

    const solution = await dotnet(root);
    if (solution.projects.length) {
        builds.dotnet = msbuild(solution.projects, solution.test);
        if (solution.projects.some((project) => /\.fsproj$/i.test(project)))
            stages.dotnet = {
                server: { provider: "fsharp" },
                build_configuration: "dotnet",
                inputs: {
                    project_model: [{ configuration: "dotnet", task: "model", output: "model" }],
                },
            };
        // .NET builds into the bin/ and obj/ beside each project file; a bin/ elsewhere in the checkout is source.
        const beside = new Set(
            solution.projects.map((project) => project.slice(0, project.lastIndexOf("/") + 1)),
        );
        for (const directory of [...beside].sort())
            ignored.push(`/${directory}bin`, `/${directory}obj`);
        summary.push(
            `Configured .NET projects ${solution.projects.join(", ")} as build configuration dotnet${stages.dotnet ? " and analysis stage dotnet (fsharp)" : ""}`,
        );
    }

    // A pyproject.toml that describes a project or its dependencies; one that only holds tool settings (a ruff section of a C++
    // repository, say) names no Python project to lock and sync.
    const pyproject = await text(join(root, "pyproject.toml"));
    const pythonproject =
        pyproject !== undefined &&
        /^\s*\[(project|tool\.poetry|tool\.pdm|build-system)\]/m.test(pyproject);
    if (pythonproject) {
        builds.python = python(/\bpytest\b/.test(pyproject!));
        ignored.push(".venv", "dist");
        summary.push("Configured uv as build configuration python");
    }

    const configurations = Object.keys(builds).sort();
    if (!configurations.length) return { summary: warnings, value: {}, ignored: [] };
    // Generated output is kept out of the source when the configurations are saved; a kept configuration leaves the files as they
    // were.
    const exclude = await unignored(root, ignored);
    const value: Settings = {
        build_configurations: sorted(builds),
        default_configurations: configurations,
    };
    const staged = Object.keys(stages).sort();
    if (staged.length)
        value.analysis = {
            main: {
                stages: sorted(stages),
                outputs: { facts: staged.map((stage) => ({ stage, output: "facts" })) },
            },
        };
    return { summary: [...summary, ...warnings], value, ignored: exclude };
}

// Saves the generated settings when the project has none, and leaves an agent- or user-authored configuration untouched.
// Returns the lines to print, or undefined when an existing configuration was kept.
export async function configure(
    core: Connection,
    project: string,
    root: string,
    setup: Setup,
): Promise<string[] | undefined> {
    const path = `/api/v1/projects/${project}`;
    const reply = await call(core, "GET", path);
    if (reply.status !== 200) throw responseError(reply);
    const current = JSON.parse(reply.body) as { revision?: unknown; value?: unknown };
    const value = object(current.value) ? (current.value as Settings) : {};
    if (object(value.build_configurations) && Object.keys(value.build_configurations).length)
        return undefined;
    const saved = await call(core, "PUT", path, {
        revision: current.revision,
        value: { ...value, ...setup.value },
    });
    if (saved.status !== 200) throw responseError(saved);
    if (setup.ignored.length) {
        await ignore(root, setup.ignored);
        return [
            ...setup.summary,
            `Kept generated output out of the source: ${setup.ignored.join(", ")} in ${rulesFile}`,
        ];
    }
    return setup.summary;
}
