import assert from "node:assert/strict";
import { readdir, writeFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { stringify } from "yaml";
import { executeCli } from "../../src/cli.ts";
import { loadProject } from "../../src/config.ts";
import { agent, createProject, validConfig } from "../support/cli-project.ts";
import { createCliDependencies } from "../support/cli-dependencies.ts";

const run = ["run", "--project", "demo", "--parent", "48"];

await test("injected terminal plugins require all three methods before external access", async (t) => {
  const { root, directory } = await createProject(t);
  for (const method of ["createTab", "execute", "closeTab"]) {
    for (const value of [undefined, false]) {
      const deps = createCliDependencies(root);
      Object.assign(deps.terminalPlugin, { [method]: value });
      const result = await executeCli(run, deps);
      assert.equal(result.exitCode, 1);
      assert.match(
        result.summary.reasons.join(" "),
        /factory must return createTab, execute, and closeTab/,
      );
      assert.deepEqual(deps.reads, []);
      assert.deepEqual(deps.effects, []);
      assert.equal(result.logPath, null);
      assert.deepEqual((await readdir(directory)).sort(), [
        "config.yaml",
        "prompts",
      ]);
    }
  }
});

await test("Agent profiles require an opaque nonempty agent before external access", async (t) => {
  const { root, directory } = await createProject(t);
  for (const purpose of [
    "implement",
    "review",
    "ciRepair",
    "conflictRepair",
    "documentation",
  ]) {
    for (const value of [undefined, "", " \n ", null, 42]) {
      await writeFile(
        path.join(directory, "config.yaml"),
        stringify({
          ...validConfig,
          agents: {
            ...validConfig.agents,
            [purpose]: { ...agent, agent: value },
          },
        }),
      );
      const deps = createCliDependencies(root);
      const result = await executeCli(run, deps);
      assert.match(
        result.summary.reasons.join(" "),
        new RegExp(`agents\\.${purpose}\\.agent must be set`),
      );
      assert.deepEqual(deps.reads, []);
      assert.deepEqual(deps.effects, []);
    }
  }
  const opaque = "  Custom.Agent/$&  ";
  await writeFile(
    path.join(directory, "config.yaml"),
    stringify({
      ...validConfig,
      agents: Object.fromEntries(
        [
          "implement",
          "review",
          "ciRepair",
          "conflictRepair",
          "documentation",
        ].map((purpose) => [purpose, { ...agent, agent: opaque }]),
      ),
    }),
  );
  const loaded = await loadProject(root, "demo", {
    TRACKER_TOKEN: "test",
    HOST_TOKEN: "test",
  });
  assert.deepEqual(
    Object.values(loaded.config.agents).map((profile) => profile.agent),
    Array(5).fill(opaque),
  );
});

await test("the command's lazy factory receives the complete terminalPlugins value once", async (t) => {
  for (const terminalPlugins of [
    undefined,
    {
      generic: { values: [null, false, 0, "  unchanged  "] },
      arbitrary: { enhancement: "not-installed" },
    },
  ]) {
    const { root } = await createProject(t, {
      ...validConfig,
      ...(terminalPlugins === undefined ? {} : { terminalPlugins }),
    });
    const deps = createCliDependencies(root);
    const result = await executeCli(run, deps);
    assert.equal(
      result.summary.outcome,
      "no_work",
      result.summary.reasons.join(" "),
    );
    assert.deepEqual(deps.terminal.calls, [
      [{ ...terminalPlugins, agentStartDelay: 10, enhancements: {} }],
    ]);
  }
});

await test("invalid modules and factory results fail with command context before workflow effects", async (t) => {
  const { root, directory } = await createProject(t);
  const modules: [unknown, RegExp][] = [
    ...[undefined, null, false, 1, "module", {}, { contractVersion: 1 }].map(
      (module): [unknown, RegExp] => [module, /contractVersion 2/],
    ),
    ...[undefined, null, false, "factory", {}].map(
      (factory): [unknown, RegExp] => [
        { contractVersion: 2, createTerminalPlugin: factory },
        /createTerminalPlugin\(config\) factory/,
      ],
    ),
    ...[undefined, null, false, 1, "plugin", {}, () => undefined].map(
      (plugin): [unknown, RegExp] => [
        {
          contractVersion: 2,
          createTerminalPlugin: () => Promise.resolve(plugin),
        },
        /factory must return createTab, execute, and closeTab/,
      ],
    ),
    [
      {
        contractVersion: 2,
        createTerminalPlugin: () =>
          Promise.reject(new Error("connection refused")),
      },
      /connection refused/,
    ],
    [
      {
        contractVersion: 2,
        createTerminalPlugin() {
          throw new Error("synchronous failure");
        },
      },
      /synchronous failure/,
    ],
  ];
  for (const [terminal, expected] of modules) {
    const deps = createCliDependencies(root);
    Object.assign(deps, { terminal });
    const result = await executeCli(run, deps);
    assert.equal(result.exitCode, 1);
    assert.match(result.summary.reasons.join(" "), expected);
    assert.match(
      result.summary.reasons.join(" "),
      /Unable to initialize generic-terminal:/,
    );
    assert.doesNotMatch(
      result.summary.reasons.join(" "),
      /sibling|Install|prefix/,
    );
    assert.equal(result.logPath, null);
    assert.deepEqual(deps.reads, []);
    assert.deepEqual(deps.effects, []);
    assert.deepEqual((await readdir(directory)).sort(), [
      "config.yaml",
      "prompts",
    ]);
  }
});

await test("cancellation during the factory is checked before audit creation", async (t) => {
  const { root, directory } = await createProject(t);
  const deps = createCliDependencies(root);
  const controller = new AbortController();
  const result = await executeCli(run, {
    ...deps,
    signal: controller.signal,
    terminal: {
      contractVersion: 2,
      createTerminalPlugin() {
        controller.abort();
        return Promise.resolve(deps.terminalPlugin);
      },
    },
  });
  assert.equal(result.exitCode, 1);
  assert.equal(result.summary.outcome, "cancelled");
  assert.equal(result.logPath, null);
  assert.deepEqual(deps.reads, []);
  assert.deepEqual(deps.effects, []);
  assert.deepEqual((await readdir(directory)).sort(), [
    "config.yaml",
    "prompts",
  ]);
});

await test("Core validates generic terminal settings before invoking the factory", async (t) => {
  const { root, directory } = await createProject(t);
  for (const terminalPlugins of [
    { agentStartDelay: -1 },
    { agentStartDelay: Infinity },
    { agentStartDelay: NaN },
    { agentStartDelay: "10" },
    { agentStartDelay: null },
    { agentStartDelay: 2147483.648 },
    { enhancements: null },
    { enhancements: [] },
    { enhancements: "codex" },
  ]) {
    await writeFile(
      path.join(directory, "config.yaml"),
      stringify({ ...validConfig, terminalPlugins }),
    );
    const deps = createCliDependencies(root);
    const result = await executeCli(run, deps);
    assert.equal(result.exitCode, 1);
    assert.match(
      result.summary.reasons.join(" "),
      /terminalPlugins\.(agentStartDelay|enhancements)/,
    );
    assert.deepEqual(deps.terminal.calls, []);
  }
});

await test("generic settings retain boundary delays and unknown enhancement values", async (t) => {
  for (const agentStartDelay of [0, 0.125, 2147483.647]) {
    const terminalPlugins = {
      agentStartDelay,
      enhancements: { arbitrary: [null, false, 42, "opaque"] },
      backend: { unchanged: true },
    };
    const { root } = await createProject(t, {
      ...validConfig,
      terminalPlugins,
    });
    const deps = createCliDependencies(root);
    assert.equal((await executeCli(run, deps)).summary.outcome, "no_work");
    assert.deepEqual(deps.terminal.calls, [[terminalPlugins]]);
  }
});
