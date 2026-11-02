/* eslint-disable @typescript-eslint/require-await -- Scripted external contracts retain asynchronous signatures. */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { executeCli } from "../../src/cli.ts";
import { loadProject } from "../../src/config.ts";
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
    const result = await executeCli(argv, {
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
    assert.ok(messages.join("\n").length > 0);
    if (argv[0] === "init")
      assert.match(messages.join("\n"), /^usage: issue-runner init --project/);
  }
  assert.deepEqual(await readdir(launchDirectory), []);
});

await test("init creates a Project without credentials and refuses to overwrite it", async (t) => {
  const launchDirectory = await mkdtemp(path.join(tmpdir(), "core-init "));
  t.after(() => rm(launchDirectory, { recursive: true, force: true }));
  const dependencies = {
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
  const runDependencies = createCliDependencies(launchDirectory);
  const generated = await executeCli(
    ["run", "--project", "demo", "--env", "fake", "--parent", "48"],
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
  for (const [brand, model, effort, bypass] of [
    [
      "Codex",
      "gpt-6.1-sol",
      'model_reasoning_effort="max"',
      "--dangerously-bypass-approvals-and-sandbox",
    ],
    [
      "CodeBuddy",
      "deepseek-v4.1-flash",
      "--effort max",
      "--dangerously-skip-permissions",
    ],
  ] as const) {
    const example = new RegExp(
      `# ${brand} \\([^\\n]+\\):\\n# start: ([^\\n]+)\\n# resume: ([^\\n]+)`,
    ).exec(config);
    assert.ok(example, `${brand} command pair is included by init`);
    const selected = config
      .replace(/^ {4}start:.*$/gm, `    start: ${example[1]}`)
      .replace(/^ {4}resume:.*$/gm, `    resume: ${example[2]}`);
    await writeFile(path.join(launchDirectory, "demo/config.yaml"), selected);
    const { config: loaded } = await loadProject(
      launchDirectory,
      "demo",
      { GH_TOKEN: "test" },
      { requireDocumentationMaintenance: true },
    );
    assert.equal(Object.values(loaded.agents).length, 5);
    for (const profile of Object.values(loaded.agents)) {
      assert.ok(profile);
      for (const command of [profile.start, profile.resume]) {
        assert.ok(command.includes(`--model ${model}`));
        assert.ok(command.includes(effort));
        assert.ok(command.includes(bypass));
        assert.ok(!command.includes("--no-daemon"));
        if (brand === "CodeBuddy")
          assert.ok(command.startsWith("CODEBUDDY_IS_SANDBOX=1 codebuddy "));
      }
      assert.ok(profile.resume.includes('"{sessionref}"'));
      assert.equal(profile.submitKey, "Enter");
      assert.equal(profile.startupDelaySeconds, 10);
    }
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
        ["run", "--project", "demo", "--env", "fake", "--parent", "48"],
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
