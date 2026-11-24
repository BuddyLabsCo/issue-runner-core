/* eslint-disable @typescript-eslint/require-await -- Scripted external contracts retain asynchronous signatures. */
import assert from "node:assert/strict";
import { appendFile, readdir, rm, writeFile, readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { stringify } from "yaml";

import { executeCli } from "../../src/cli.ts";
import { loadProject } from "../../src/config.ts";
import { agent, createProject, validConfig } from "../support/cli-project.ts";
import { createCliDependencies } from "../support/cli-dependencies.ts";

const run = ["run", "--project", "demo", "--parent", "48"];

await test("the CLI requires no project credential or token environment variable", async (t) => {
  const { root } = await createProject(t);
  const dependencies = createCliDependencies(root);
  const result = await executeCli(run, dependencies);
  assert.equal(result.summary.outcome, "no_work", result.summary.failure);
});

await test("legacy tokenEnv and unknown Core-owned keys are ignored without changing config bytes", async (t) => {
  const config = {
    ...validConfig,
    obsolete: { enabled: true },
    tracker: {
      ...validConfig.tracker,
      runnerAccount: "runner",
      tokenEnv: "MISSING",
      futureTrackerOption: true,
    },
    codeHost: {
      ...validConfig.codeHost,
      tokenEnv: "MISSING",
      futureHostOption: "ignored",
    },
    workflow: { review: false, futureWorkflowOption: 1 },
    agents: {
      ...validConfig.agents,
      futureRole: agent,
      implement: { ...agent, futureAgentOption: "ignored" },
    },
    maintenanceTicket: { futureDocumentationOption: true },
    timeouts: { ...validConfig.timeouts, futureTimeout: 1 },
  };
  const { root, directory } = await createProject(t, config);
  const bytes = await readFile(path.join(directory, "config.yaml"));
  const loaded = await loadProject(root, "demo", {});

  assert.equal("tokenEnv" in loaded.config.codeHost, false);
  assert.equal("tokenEnv" in loaded.config.tracker, false);
  assert.deepEqual(loaded.config.tracker, {
    reservationLabel: validConfig.tracker.reservationLabel,
  });
  assert.deepEqual(loaded.config.codeHost, validConfig.codeHost);
  assert.deepEqual(loaded.config.workflow, {
    review: false,
    docMaintainTriggerLabel: "",
  });
  assert.deepEqual(Object.keys(loaded.config.agents).sort(), [
    "ciRepair",
    "conflictRepair",
    "implement",
    "review",
  ]);
  assert.deepEqual(await readFile(path.join(directory, "config.yaml")), bytes);
  assert.equal(
    (await executeCli(run, createCliDependencies(root))).summary.outcome,
    "no_work",
  );
});

await test("omitted terminalPlugins supplies Core defaults", async (t) => {
  const { root } = await createProject(t);
  const loaded = await loadProject(root, "demo");
  assert.deepEqual(loaded.config.terminalPlugins, {
    agentStartDelay: 10,
    enhancements: {},
  });
});

await test("tagged terminalPlugins containers fail before external access", async (t) => {
  const { root, directory } = await createProject(t);
  for (const container of [
    "!!timestamp 2002-12-14",
    "!!binary YWJj",
    "!!set { key: null }",
  ]) {
    await writeFile(
      path.join(directory, "config.yaml"),
      `${stringify(validConfig)}\nterminalPlugins: ${container}\n`,
    );
    const deps = createCliDependencies(root);
    await assert.rejects(loadProject(root, "demo"), /terminalPlugins/);
    const result = await executeCli(run, deps);
    assert.equal(result.exitCode, 1, container);
    assert.equal(result.logPath, null);
    assert.deepEqual(deps.reads, []);
    assert.deepEqual(deps.terminal.calls, []);
    assert.deepEqual(deps.effects, []);
  }
});

await test("terminalPlugins preserves plugin-owned nested values without installation checks", async (t) => {
  const terminalPlugins = {
    fake: {
      enhancement: "not-installed",
      options: [null, false, 0, "  native  "],
    },
    other: { nested: { enabled: true, entries: [] } },
  };
  const { root, directory } = await createProject(t, {
    ...validConfig,
    terminalPlugins,
  });
  await appendFile(
    path.join(directory, "config.yaml"),
    `  tagged:
    timestamp: !!timestamp 2002-12-14
    binary: !!binary YWJj
    set: !!set { key: null }
`,
  );
  const loaded = await loadProject(root, "demo");
  assert.deepEqual(loaded.config.terminalPlugins, {
    ...terminalPlugins,
    agentStartDelay: 10,
    enhancements: {},
    tagged: {
      timestamp: new Date("2002-12-14T00:00:00.000Z"),
      binary: Buffer.from("abc"),
      set: new Set(["key"]),
    },
  });
  assert.equal(
    (await executeCli(run, createCliDependencies(root))).summary.outcome,
    "no_work",
  );
});

await test("invalid configuration fails before any external reads or delivery resources", async (t) => {
  const cases: [object, RegExp][] = [
    [{ repository: "invalid" }, /repository/],
    [{ checkout: "relative/repo" }, /checkout/],
    [{ issueList: [1, 1] }, /unique/],
    [{ issueList: [0] }, /positive/],
    [{ issueList: "1" }, /array/],
    ...[null, false, 1, [], {}].map((issueLabel): [object, RegExp] => [
      { issueLabel },
      /issueLabel must be a string/,
    ]),
    [{ maxBatchSize: 0 }, /maxBatchSize/],
    [{ maxBatchSize: 1.5 }, /maxBatchSize/],
    [{ targetBranch: " " }, /targetBranch/],
    [
      { tracker: { ...validConfig.tracker, reservationLabel: "" } },
      /tracker\.reservationLabel/,
    ],
    ...[null, [], "plugin", 1, false].map(
      (terminalPlugins): [object, RegExp] => [
        { terminalPlugins },
        /terminalPlugins must be an object/,
      ],
    ),
    [{ operationRetry: -1 }, /operationRetry/],
    [{ operationRetryDelay: [] }, /operationRetryDelay/],
    [{ workflow: { review: "false" } }, /workflow.review/],
    [{ workflow: { maxReviewRounds: 0 } }, /maxReviewRounds/],
    [
      { workflow: { docMaintainTriggerLabel: false } },
      /docMaintainTriggerLabel/,
    ],
    [
      { agents: { ...validConfig.agents, implement: { ...agent, start: "" } } },
      /implement.start/,
    ],
    [
      {
        agents: {
          ...validConfig.agents,
          implement: { ...agent, start: " \n " },
        },
      },
      /implement.start/,
    ],
    [
      {
        agents: {
          ...validConfig.agents,
          implement: { ...agent, resume: ["cli", "{sessionref}"] },
        },
      },
      /implement.resume/,
    ],
    [
      {
        agents: {
          ...validConfig.agents,
          implement: { ...agent, resume: "cli --latest" },
        },
      },
      /exact \{sessionref\}/,
    ],
    [
      {
        agents: {
          ...validConfig.agents,
          implement: { ...agent, resume: "cli {session_ref}" },
        },
      },
      /exact \{sessionref\}/,
    ],
    [
      {
        agents: {
          ...validConfig.agents,
          implement: { ...agent, submitKey: " " },
        },
      },
      /submitKey/,
    ],
    [
      {
        agents: {
          ...validConfig.agents,
          implement: { ...agent, options: { submitKey: "Enter" } },
        },
      },
      /outside options/,
    ],
    [
      { codeHost: { ...validConfig.codeHost, adminMerge: "true" } },
      /adminMerge/,
    ],
    [
      { timeouts: { ...validConfig.timeouts, requiredChecksMinutes: 0 } },
      /requiredChecksMinutes/,
    ],
    [
      { timeouts: { ...validConfig.timeouts, mergeQueueMinutes: 0 } },
      /mergeQueueMinutes/,
    ],
  ];
  const { root, directory } = await createProject(t);
  for (const [patch, expected] of cases) {
    await writeFile(
      path.join(directory, "config.yaml"),
      stringify({ ...validConfig, ...patch }),
    );
    const deps = createCliDependencies(root);
    const result = await executeCli(run, deps);
    assert.equal(result.exitCode, 1, JSON.stringify(patch));
    assert.match(result.summary.failure!, expected);
    assert.equal(result.logPath, null);
    assert.deepEqual(deps.effects, []);
    assert.deepEqual(deps.reads, []);
    assert.deepEqual(deps.terminal.calls, []);
    assert.deepEqual((await readdir(directory)).sort(), [
      "config.yaml",
      "prompts",
    ]);
  }
});

await test("Project selection uses only its named launch-directory child", async (t) => {
  const { root, directory } = await createProject(t);
  for (const project of [
    ".",
    "..",
    "../demo",
    directory,
    "nested/demo",
    "missing",
  ]) {
    const deps = createCliDependencies(root);
    const result = await executeCli(
      ["run", "--project", project, "--parent", "48"],
      deps,
    );
    assert.equal(result.exitCode, 1);
    assert.deepEqual(deps.reads, []);
    assert.deepEqual(deps.terminal.calls, []);
  }
  const nested = createCliDependencies(path.join(root, "demo"));
  assert.equal(
    (await executeCli(run, nested)).exitCode,
    1,
    "must not find config in an ancestor",
  );
});

await test("Review defaults on; disabled Review and maintenance do not require their profiles or prompts", async (t) => {
  const config = {
    ...validConfig,
    agents: { implement: agent, ciRepair: agent, conflictRepair: agent },
  };
  const { root, directory } = await createProject(t, config);
  assert.match(
    (await executeCli(run, createCliDependencies(root))).summary.failure!,
    /Review is enabled/,
  );
  await writeFile(
    path.join(directory, "config.yaml"),
    stringify({
      ...config,
      workflow: { review: false, docMaintainTriggerLabel: "  " },
    }),
  );
  await rm(path.join(directory, "prompts/review.md"));
  await rm(path.join(directory, "prompts/documentation.md"));
  assert.equal(
    (await executeCli(run, createCliDependencies(root))).summary.outcome,
    "no_work",
  );
});

await test("enabled purposes require their profiles, prompts, and maintenance metadata", async (t) => {
  const { root, directory } = await createProject(t);
  for (const purpose of ["implement", "review"]) {
    const file = path.join(directory, "prompts", `${purpose}.md`);
    const saved = await readFile(file, "utf8");
    await writeFile(file, " \n ");
    const deps = createCliDependencies(root);
    assert.equal((await executeCli(run, deps)).exitCode, 1);
    assert.deepEqual(deps.reads, []);
    assert.deepEqual(deps.terminal.calls, []);
    await writeFile(file, saved);
  }
  for (const trigger of ["documentation", " Documentation "]) {
    await writeFile(
      path.join(directory, "config.yaml"),
      stringify({
        ...validConfig,
        workflow: { docMaintainTriggerLabel: trigger },
      }),
    );
    assert.match(
      (await executeCli(run, createCliDependencies(root))).summary.failure!,
      /Documentation Maintenance is enabled/,
    );
  }
  const config = {
    ...validConfig,
    agents: { ...validConfig.agents, documentation: agent },
    workflow: { docMaintainTriggerLabel: "documentation" },
    maintenanceTicket: {
      title: "Docs",
      body: "Update docs",
      label: "doc-maintain",
    },
  };
  for (const field of ["title", "body", "label"]) {
    await writeFile(
      path.join(directory, "config.yaml"),
      stringify({
        ...config,
        maintenanceTicket: { ...config.maintenanceTicket, [field]: "" },
      }),
    );
    assert.match(
      (await executeCli(run, createCliDependencies(root))).summary.failure!,
      new RegExp(`maintenanceTicket.${field}`),
    );
  }
  await writeFile(path.join(directory, "config.yaml"), stringify(config));
  await rm(path.join(directory, "prompts/documentation.md"));
  assert.match(
    (await executeCli(run, createCliDependencies(root))).summary.failure!,
    /Documentation Maintenance is enabled/,
  );
});

await test("Run modes are exclusive and auto-merge is restricted before external access", async (t) => {
  const { root } = await createProject(t);
  const prefix = ["run", "--project", "demo"];
  for (const scope of [
    [],
    ["--parent"],
    ["--parent", "0"],
    ["--parent", "1.5"],
    ["--parent", "48", "--issue", "49"],
    ["--issue", "--document"],
    ["--parent", "48", "--no-auto-merge"],
    ["--issue", "--auto-merge"],
    ["--issue", "49", "--auto-merge", "--no-auto-merge"],
    ["--issue", "49", "--no-auto-merge", "true"],
    ["--document=false"],
    ["--parent", "48", "--unknown"],
    ["--parent", "48", "--env", "fake"],
  ]) {
    const deps = createCliDependencies(root);
    assert.equal(
      (await executeCli([...prefix, ...scope], deps)).exitCode,
      1,
      scope.join(" "),
    );
    assert.deepEqual(deps.reads, []);
    assert.deepEqual(deps.terminal.calls, []);
    assert.deepEqual(deps.effects, []);
  }
});

await test("option ordering and configured Target Branch do not change the empty-parent result", async (t) => {
  const { root } = await createProject(t, {
    ...validConfig,
    targetBranch: "release",
    issueList: [7, 2],
  });
  const deps = createCliDependencies(root);
  deps.codeHost.resolveTargetBranch = async () => {
    assert.fail("configured branch wins");
  };
  const result = await executeCli(
    ["run", "--parent", "48", "--project", "demo"],
    deps,
  );
  assert.equal(result.summary.outcome, "no_work");
  assert.equal(result.summary.targetBranch, "release");
});

await test("ineligible Issue scopes do not dispatch and documentation requires configuration", async (t) => {
  const { root } = await createProject(t, {
    ...validConfig,
    issueList: [9, 2],
  });
  for (const scope of [
    ["--issue"],
    ["--issue", "9", "--no-auto-merge"],
    ["--issue", "9", "--auto-merge"],
  ]) {
    const deps = createCliDependencies(root);
    const result = await executeCli(
      ["run", "--project", "demo", ...scope],
      deps,
    );
    assert.equal(result.summary.outcome, "incomplete");
    assert.deepEqual(deps.effects, []);
  }
  const document = [
    "run",
    "--project",
    "demo",
    "--document",
    "--no-auto-merge",
  ];
  assert.equal(
    (await executeCli(document, createCliDependencies(root))).summary.outcome,
    "failed",
  );
});

await test("Agent retry settings are optional and legacy values are ignored", async (t) => {
  const config = validConfig;
  for (const legacy of [{}, { agentRetry: 0.5, agentRetryDelay: [0] }]) {
    const { root } = await createProject(t, { ...config, ...legacy });
    const result = await executeCli(run, createCliDependencies(root));
    assert.equal(result.summary.outcome, "no_work", JSON.stringify(result));
  }
});

for (const ticketClosure of ["runner", "code_host"] as const) {
  await test(`legacy ${ticketClosure} closure loads unchanged bytes without exposing a runtime option`, async (t) => {
    const { root, directory } = await createProject(t, {
      ...validConfig,
      ticketClosure,
    });
    const file = path.join(directory, "config.yaml");
    const bytes = await readFile(file);
    const loaded = await loadProject(root, "demo");
    assert.equal("ticketClosure" in loaded.config, false);
    assert.deepEqual(await readFile(file), bytes);
  });
}
