// What `fug init` concludes from a checkout's manifests, and that the core accepts the settings it writes.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { detect } from "../build/setup.js";
import { Rules } from "../build/checkout/ignore.js";
import { call } from "../build/remote.js";
import { scratch, service, start } from "./service.mjs";

async function fixture(name, files) {
    const root = await scratch(name);
    for (const [path, content] of Object.entries(files)) {
        await mkdir(join(root, path, ".."), { recursive: true });
        await writeFile(join(root, path), content);
    }
    return root;
}

const cmake = {
    "CMakeLists.txt": "cmake_minimum_required(VERSION 3.20)\nproject(demo CXX)\n",
    "CMakePresets.json": JSON.stringify({
        version: 6,
        configurePresets: [
            { name: "base", hidden: true, generator: "Ninja" },
            { name: "release", inherits: "base", binaryDir: "${sourceDir}/build/release" },
            { name: "debug", inherits: "base", binaryDir: "${sourceDir}/build/debug" },
        ],
    }),
};

test("CMake presets pick the debug preset and name the generated output to keep out", async () => {
    const root = await fixture("setup-cmake", cmake);
    try {
        const setup = await detect(root);
        const builds = setup.value.build_configurations;
        assert.deepEqual(Object.keys(builds), ["debug"]);
        assert.deepEqual(builds.debug.builders.main.options, {
            build_dir: "build/debug",
            export_compile_commands: true,
            preset: "debug",
        });
        assert.deepEqual(Object.keys(builds.debug.operations), ["build", "test"]);
        assert.deepEqual(setup.value.default_configurations, ["debug"]);
        const stage = setup.value.analysis.main.stages.cpp;
        assert.equal(stage.server.provider, "clice");
        assert.deepEqual(stage.inputs.compilation_database, [
            { configuration: "debug", task: "configure", output: "compilation_database" },
        ]);
        assert.deepEqual(setup.value.analysis.main.outputs, {
            facts: [{ stage: "cpp", output: "facts" }],
        });
        assert.deepEqual(setup.ignored, ["build/debug"]);
        await assert.rejects(readFile(join(root, ".fughettaignore"), "utf8"), { code: "ENOENT" });
    } finally {
        await rm(root, { recursive: true, force: true });
    }
});

test("an ignored build directory is not repeated and a checkout without presets configures Ninja", async () => {
    const root = await fixture("setup-cmake-plain", {
        "CMakeLists.txt": "cmake_minimum_required(VERSION 3.20)\nproject(demo CXX)\n",
        ".gitignore": "build/\n",
    });
    try {
        const setup = await detect(root);
        assert.deepEqual(setup.value.build_configurations.debug.builders.main.options, {
            build_dir: "build/debug",
            export_compile_commands: true,
            generator: "Ninja",
            build_type: "Debug",
        });
        await assert.rejects(readFile(join(root, ".fughettaignore"), "utf8"), { code: "ENOENT" });
    } finally {
        await rm(root, { recursive: true, force: true });
    }
});

test("a vendored vcpkg supplies the CMake toolchain unless a preset names one", async () => {
    const vendored = {
        "CMakeLists.txt": "cmake_minimum_required(VERSION 3.20)\nproject(demo CXX)\n",
        "vcpkg.json": '{ "name": "demo" }\n',
        "vcpkg/scripts/buildsystems/vcpkg.cmake": "toolchain\n",
        "CMakePresets.json": JSON.stringify({
            version: 6,
            configurePresets: [{ name: "debug", generator: "Ninja" }],
        }),
    };
    const plain = await fixture("setup-vcpkg", vendored);
    const preset = await fixture("setup-vcpkg-preset", {
        ...vendored,
        "CMakePresets.json": JSON.stringify({
            version: 6,
            configurePresets: [
                { name: "base", hidden: true, toolchainFile: "cmake/toolchain.cmake" },
                { name: "debug", inherits: "base", generator: "Ninja" },
            ],
        }),
    });
    try {
        const generated = await detect(plain);
        assert.equal(
            generated.value.build_configurations.debug.builders.main.options.toolchain_file,
            "vcpkg/scripts/buildsystems/vcpkg.cmake",
        );
        const owned = await detect(preset);
        assert.equal(
            owned.value.build_configurations.debug.builders.main.options.toolchain_file,
            undefined,
        );
    } finally {
        await Promise.all(
            [plain, preset].map((root) => rm(root, { recursive: true, force: true })),
        );
    }
});

test("detection leaves a top-level build directory, tool-only pyproject files, nested projects and vcpkg alone", async () => {
    const roots = await Promise.all([
        fixture("setup-build-dir", {
            "App.sln": 'Project("{F}") = "App", "App\\App.fsproj", "{1}"\nEndProject\n',
            "App/App.fsproj": '<Project Sdk="Microsoft.NET.Sdk"></Project>\n',
            "build/Common.props": "<Project></Project>\n",
        }),
        fixture("setup-tool-only", {
            "CMakeLists.txt": "cmake_minimum_required(VERSION 3.20)\nproject(demo CXX)\n",
            "pyproject.toml": '[tool.ruff]\nline-length = 100\n[tool.ruff.lint]\nselect = ["E"]\n',
        }),
        fixture("setup-slnx-nested", {
            "App.slnx": '<Solution><Project Path="src/Other/Other.fsproj" /></Solution>\n',
            "src/App/App.fsproj": '<Project Sdk="Microsoft.NET.Sdk"></Project>\n',
            "src/App/bin/Debug/x.fsproj": "",
            "src/App/obj/ProjectModel.json": "{}",
            "src/Other/Other.fsproj": '<Project Sdk="Microsoft.NET.Sdk"></Project>\n',
        }),
        fixture("setup-settings-only", {
            "settings.gradle.kts": 'rootProject.name = "demo"\ninclude("app")\n',
            "app/build.gradle.kts": 'plugins { id("org.jetbrains.kotlin.jvm") }\n',
        }),
        fixture("setup-vcpkg", {
            "CMakeLists.txt": "cmake_minimum_required(VERSION 3.20)\nproject(demo CXX)\n",
            "vcpkg.json": '{ "name": "demo" }\n',
        }),
    ]);
    const [assets, ruff, slnx, settings, vcpkg] = roots;
    try {
        const dotnet = await detect(assets);
        assert.deepEqual(
            dotnet.value.build_configurations.dotnet.builders.dotnet.options.projects,
            ["App/App.fsproj"],
        );
        assert.deepEqual(dotnet.ignored, ["/App/bin", "/App/obj"]);
        // The rules name the project's own output; a bin/ of scripts at the root is still sent.
        await mkdir(join(assets, ".fughetta"));
        await writeFile(
            join(assets, ".fughetta/ignore"),
            dotnet.ignored.map((directory) => `${directory}/\n`).join(""),
        );
        const rules = await Rules.root().enter(assets, "");
        assert.equal(rules.ignored("App/bin", true), true);
        assert.equal(rules.ignored("App/obj", true), true);
        assert.equal(rules.ignored("bin", true), false);
        assert.deepEqual((await detect(assets)).ignored, []);

        const cmake = await detect(ruff);
        assert.deepEqual(Object.keys(cmake.value.build_configurations), ["debug"]);
        assert.deepEqual(cmake.value.default_configurations, ["debug"]);

        // The solution names its projects at any depth.
        const nested = await detect(slnx);
        assert.deepEqual(
            nested.value.build_configurations.dotnet.builders.dotnet.options.projects,
            ["src/Other/Other.fsproj"],
        );
        // Without one, the search skips build output.
        await rm(join(slnx, "App.slnx"));
        assert.deepEqual(
            (await detect(slnx)).value.build_configurations.dotnet.builders.dotnet.options.projects,
            ["src/App/App.fsproj", "src/Other/Other.fsproj"],
        );

        const multi = await detect(settings);
        assert.deepEqual(Object.keys(multi.value.build_configurations), ["jvm"]);

        const manifest = await detect(vcpkg);
        assert.equal(
            manifest.value.build_configurations.debug.builders.main.options.toolchain_file,
            undefined,
        );
        assert.match(manifest.summary.join("\n"), /vcpkg\.json is present, but no toolchain file/);
    } finally {
        await Promise.all(roots.map((root) => rm(root, { recursive: true, force: true })));
    }
});

test("Gradle, a .NET solution and pyproject each generate one configuration and one stage", async () => {
    const gradleRoot = await fixture("setup-gradle", {
        "build.gradle.kts": 'plugins { id("org.jetbrains.kotlin.jvm") version "2.4.21" }\n',
    });
    const dotnetRoot = await fixture("setup-dotnet", {
        "demo.sln":
            'Project("{F2A71F9B-5D33-465A-A702-920D77279786}") = "App", "App\\App.fsproj", "{1}"\nEndProject\n',
        "App/App.fsproj":
            '<Project Sdk="Microsoft.NET.Sdk"><ItemGroup><PackageReference Include="Microsoft.NET.Test.Sdk" Version="17.0.0" /></ItemGroup></Project>\n',
    });
    const pythonRoot = await fixture("setup-python", {
        "pyproject.toml": '[project]\nname = "demo"\ndependencies = ["pytest"]\n',
    });
    try {
        const gradle = await detect(gradleRoot);
        assert.deepEqual(Object.keys(gradle.value.build_configurations), ["jvm"]);
        assert.deepEqual(gradle.value.build_configurations.jvm.tasks.test.parameters, {
            targets: ["test"],
        });
        assert.equal(gradle.value.analysis.main.stages.jvm.server.provider, "kotlin");

        const dotnet = await detect(dotnetRoot);
        assert.deepEqual(
            dotnet.value.build_configurations.dotnet.builders.dotnet.options.projects,
            ["App/App.fsproj"],
        );
        assert.deepEqual(dotnet.value.build_configurations.dotnet.builders["dotnet-test"].options, {
            operations: {
                test: { argv: ["dotnet", "test", "App/App.fsproj"], working_dir: "." },
            },
        });
        assert.equal(dotnet.value.analysis.main.stages.dotnet.server.provider, "fsharp");

        const python = await detect(pythonRoot);
        assert.equal(
            python.value.build_configurations.python.builders.uv.options.run_command[0],
            "pytest",
        );
        assert.equal(python.value.build_configurations.python.operations.test.tasks[0], "test");
        assert.equal(python.value.analysis.main.stages.python.server.provider, "ty");
    } finally {
        await Promise.all(
            [gradleRoot, dotnetRoot, pythonRoot].map((root) =>
                rm(root, { recursive: true, force: true }),
            ),
        );
    }
});

test("a project without a recognized manifest gets no settings, and a polyglot one gets one profile", async () => {
    const empty = await scratch("setup-empty");
    const mixed = await fixture("setup-mixed", {
        ...cmake,
        "pyproject.toml": '[project]\nname = "demo"\n',
    });
    try {
        assert.deepEqual((await detect(empty)).value, {});
        const setup = await detect(mixed);
        assert.deepEqual(Object.keys(setup.value.build_configurations), ["debug", "python"]);
        assert.deepEqual(setup.value.default_configurations, ["debug", "python"]);
        assert.deepEqual(Object.keys(setup.value.analysis), ["main"]);
        assert.deepEqual(Object.keys(setup.value.analysis.main.stages), ["cpp", "python"]);
        assert.deepEqual(setup.value.analysis.main.outputs, {
            facts: [
                { stage: "cpp", output: "facts" },
                { stage: "python", output: "facts" },
            ],
        });
    } finally {
        await rm(empty, { recursive: true, force: true });
        await rm(mixed, { recursive: true, force: true });
    }
});

test(
    "the core accepts the settings detect writes and plans their analysis graph",
    { timeout: 120_000, skip: service },
    async () => {
        const core = await start("setup-core");
        const connection = { server: core.origin, workspace: "", token: core.token };
        const roots = [];
        try {
            for (const [name, files] of Object.entries({
                cmake,
                gradle: { "build.gradle": "plugins { id 'org.jetbrains.kotlin.jvm' }\n" },
                dotnet: {
                    "demo.sln": 'Project("{F}") = "App", "App\\App.fsproj", "{1}"\n',
                    "App/App.fsproj":
                        '<Project Sdk="Microsoft.NET.Sdk"><ItemGroup><PackageReference Include="Microsoft.NET.Test.Sdk" /></ItemGroup></Project>\n',
                },
                python: { "pyproject.toml": '[project]\nname = "demo"\n' },
            })) {
                const root = await fixture(`setup-core-${name}`, files);
                roots.push(root);
                const setup = await detect(root);
                assert.ok(setup, name);
                await call(connection, "PUT", `/api/v1/projects/${name}`, {
                    revision: 0,
                    value: {},
                });
                const current = await call(connection, "GET", `/api/v1/projects/${name}`);
                const saved = await call(connection, "PUT", `/api/v1/projects/${name}`, {
                    revision: JSON.parse(current.body).revision,
                    value: setup.value,
                });
                assert.equal(saved.status, 200, saved.body);
                const read = await call(connection, "GET", `/api/v1/projects/${name}`);
                const value = JSON.parse(read.body).value;
                assert.deepEqual(
                    Object.keys(value.build_configurations).sort(),
                    Object.keys(setup.value.build_configurations).sort(),
                    name,
                );
            }
        } finally {
            for (const root of roots) await rm(root, { recursive: true, force: true });
            assert.equal(await core.stop(), 0);
        }
    },
);
