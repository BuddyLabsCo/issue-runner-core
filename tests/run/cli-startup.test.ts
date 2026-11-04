/* eslint-disable @typescript-eslint/require-await -- Scripted external contracts retain asynchronous signatures. */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { terminalInstallation } from "../fixtures/enhancement-installation.mjs";
import { executeCli } from "../../src/cli.ts";
import { createCliDependencies } from "../support/cli-dependencies.ts";
import { createProject, validConfig } from "../support/cli-project.ts";

await test("help and version need no Project, credentials, plugin, or delivery resources", async (t) => {
  const launchDirectory = await mkdtemp(path.join(tmpdir(), "core-startup "));
  t.after(() => rm(launchDirectory, { recursive: true, force: true }));
  for (const argv of [
    [],
    ["--help"],
    ["run", "-h"],
    ["init", "--help"],
    ["--version"],
  ]) {
    const messages: string[] = [];
    const deps = createCliDependencies(launchDirectory);
    const result = await executeCli(argv, {
      ...deps,
      launchDirectory,
      env: {},
      operator: {
        write(message) {
          messages.push(message);
        },
        async pause() {
          assert.fail("informational commands must not pause");
        },
      },
    });
    assert.equal(result.exitCode, 0);
    assert.deepEqual(deps.terminal.calls, []);
    assert.match(messages.join("\n"), /generic-terminal/);
    if (argv[0] === "--version") {
      const manifest = JSON.parse(
        await readFile(new URL("../../package.json", import.meta.url), "utf8"),
      ) as { version: string };
      assert.equal(
        messages[0],
        `generic-terminal 2.3.4 (core ${manifest.version})`,
      );
    }
    assert.ok(messages.join("\n").length > 0);
    if (argv[0] === "init")
      assert.match(
        messages.join("\n"),
        /^usage: generic-terminal init --project/,
      );
  }
  assert.deepEqual(await readdir(launchDirectory), []);
});

await test("init creates a Project without credentials and refuses to overwrite it", async (t) => {
  const launchDirectory = await mkdtemp(path.join(tmpdir(), "core-init "));
  t.after(() => rm(launchDirectory, { recursive: true, force: true }));
  const dependencies = {
    ...createCliDependencies(launchDirectory),
    launchDirectory,
    env: {},
    operator: {
      write() {
        /* Init output is checked through its created files. */
      },
      async pause(): Promise<"cancel"> {
        return "cancel";
      },
    },
  };
  const args = ["init", "--project", "demo"];
  assert.equal((await executeCli(args, dependencies)).exitCode, 0);
  const config = await readFile(
    path.join(launchDirectory, "demo/config.yaml"),
    "utf8",
  );
  for (const purpose of ["implement", "review", "documentation"]) {
    assert.ok(
      (
        await readFile(
          path.join(launchDirectory, `demo/prompts/${purpose}.md`),
          "utf8",
        )
      ).trim(),
    );
  }
  assert.equal((await executeCli(args, dependencies)).exitCode, 1);
  assert.equal(
    await readFile(path.join(launchDirectory, "demo/config.yaml"), "utf8"),
    config,
  );
  assert.deepEqual(dependencies.terminal.calls, []);
  const runDependencies = createCliDependencies(launchDirectory);
  const generated = await executeCli(
    ["run", "--project", "demo", "--parent", "48"],
    { ...runDependencies, env: { GH_TOKEN: "test" } },
  );
  assert.equal(
    generated.summary.outcome,
    "no_work",
    generated.summary.reasons.join(" "),
  );
  for (const project of [
    ".",
    "..",
    "../escape",
    "nested/project",
    "/absolute",
  ]) {
    assert.equal(
      (await executeCli(["init", "--project", project], dependencies)).exitCode,
      1,
    );
  }
});

await test("EOF during a real Operator Pause returns and reports a cancelled Run", async (t) => {
  const { root } = await createProject(t, {
    ...validConfig,
    operationRetry: 0,
  });
  const child = spawnSync(
    process.execPath,
    [
      "--input-type=module",
      "--eval",
      `
      import { executeCli } from ${JSON.stringify(new URL("../../src/cli.ts", import.meta.url).href)};
      import { TerminalOperator } from ${JSON.stringify(new URL("../../src/adapters/terminal.ts", import.meta.url).href)};
      import { createCliDependencies } from ${JSON.stringify(new URL("../support/cli-dependencies.ts", import.meta.url).href)};
      const dependencies = createCliDependencies(${JSON.stringify(root)});
      dependencies.tracker.getParent = async () => { throw new Error("tracker unavailable"); };
      const result = await executeCli(
        ["run", "--project", "demo", "--parent", "48"],
        { ...dependencies, operator: new TerminalOperator() },
      );
      console.log("RESULT", result.exitCode, result.summary.outcome);
    `,
    ],
    { input: "", encoding: "utf8", timeout: 10_000 },
  );
  assert.ifError(child.error);
  assert.equal(child.status, 0, child.stderr);
  assert.match(child.stdout, /Run cancelled\./);
  assert.match(child.stdout, /RESULT 1 cancelled/);
});

await test("public CLI import is inert and exports only runCli", () => {
  const child = spawnSync(
    process.execPath,
    [
      "--input-type=module",
      "--eval",
      `
    import assert from "node:assert/strict";
    process.argv = [process.execPath, "generic-terminal", "--version"];
    const before = [process.listenerCount("SIGINT"), process.listenerCount("SIGTERM")];
    const cli = await import(${JSON.stringify(new URL("../../src/cli-entry.ts", import.meta.url).href)});
    assert.deepEqual(Object.keys(cli), ["runCli"]);
    assert.deepEqual([process.listenerCount("SIGINT"), process.listenerCount("SIGTERM")], before);
    assert.equal(process.exitCode, undefined);
  `,
    ],
    { encoding: "utf8", timeout: 10_000 },
  );
  assert.ifError(child.error);
  assert.equal(child.status, 0, child.stderr);
  assert.equal(child.stdout, "");
});

await test("public process entry handles signals after a pending factory and removes only its listeners", async (t) => {
  for (const signal of ["SIGINT", "SIGTERM"]) {
    const { root, directory } = await createProject(t);
    const installation = terminalInstallation(path.join(root, "global prefix"));
    const child = spawnSync(
      process.execPath,
      [
        "--input-type=module",
        "--eval",
        `
      import assert from "node:assert/strict";
      const { runCli } = await import(${JSON.stringify(new URL("../../src/cli-entry.ts", import.meta.url).href)});
      process.argv = [process.execPath, "generic-terminal", "run", "--project", "demo", "--parent", "48"];
      const existing = () => {};
      process.on("SIGINT", existing);
      process.on("SIGTERM", existing);
      const before = [process.listeners("SIGINT"), process.listeners("SIGTERM")];
      let release;
      let entered;
      let settled = false;
      const pending = new Promise(resolve => { release = resolve; });
      const started = new Promise(resolve => { entered = resolve; });
      const run = runCli({
        commandName: "generic-terminal", commandVersion: "2.3.4",
        ...${JSON.stringify(installation)},
        terminal: {
          contractVersion: 2,
          async createTerminalPlugin(config) {
            assert.deepEqual(config, { agentStartDelay: 10, enhancements: {} });
            assert.equal(arguments.length, 1);
            entered();
            await pending;
            const forbidden = async () => assert.fail("cancelled run must not use terminal");
            return { createTab: forbidden, execute: forbidden, closeTab: forbidden };
          }
        }
      }).then(value => { assert.equal(value, undefined); settled = true; });
      await started;
      process.emit(${JSON.stringify(signal)});
      await Promise.resolve();
      assert.equal(settled, false, "pending factories are not forcibly cancelled");
      release();
      await run;
      assert.equal(process.exitCode, 1);
      assert.deepEqual([process.listeners("SIGINT"), process.listeners("SIGTERM")], before);
    `,
      ],
      {
        cwd: root,
        env: { ...process.env, TRACKER_TOKEN: "test", HOST_TOKEN: "test" },
        encoding: "utf8",
        timeout: 10_000,
      },
    );
    assert.ifError(child.error);
    assert.equal(child.status, 1, child.stderr);
    assert.equal(child.stderr, "");
    assert.match(child.stdout, /Startup cancelled \(generic-terminal\)/);
    assert.deepEqual((await readdir(directory)).sort(), [
      "config.yaml",
      "prompts",
    ]);
  }
});

await test("public entry sets exitCode for success and handled failures and cleans listeners each time", async (t) => {
  const { root } = await createProject(t);
  const installation = terminalInstallation(path.join(root, "global prefix"));
  const child = spawnSync(
    process.execPath,
    [
      "--input-type=module",
      "--eval",
      `
    import assert from "node:assert/strict";
    const { runCli } = await import(${JSON.stringify(new URL("../../src/cli-entry.ts", import.meta.url).href)});
    const before = [process.listenerCount("SIGINT"), process.listenerCount("SIGTERM")];
    let calls = 0;
    const options = {
      commandName: "generic-terminal", commandVersion: "2.3.4",
        ...${JSON.stringify(installation)},
      terminal: { contractVersion: 2, async createTerminalPlugin() { calls++; throw new Error("factory rejected"); } }
    };
    for (const [args, expected, factories] of [
      [["--help"], 0, 0],
      [["run", "--project", "demo", "--parent", "48", "--env", "old"], 1, 0],
      [["run", "--project", "demo", "--parent", "48"], 1, 1],
      [["--version"], 0, 1],
    ]) {
      process.argv = [process.execPath, "generic-terminal", ...args];
      process.exitCode = 17;
      assert.equal(await runCli(options), undefined);
      assert.equal(process.exitCode, expected);
      assert.equal(calls, factories);
      assert.deepEqual([process.listenerCount("SIGINT"), process.listenerCount("SIGTERM")], before);
    }
  `,
    ],
    {
      cwd: root,
      env: { ...process.env, TRACKER_TOKEN: "test", HOST_TOKEN: "test" },
      encoding: "utf8",
      timeout: 10_000,
    },
  );
  assert.ifError(child.error);
  assert.equal(child.status, 0, child.stderr);
  assert.match(child.stdout, /Unknown option.*--env/);
  assert.match(
    child.stdout,
    /Unable to initialize generic-terminal: factory rejected/,
  );
});
