/* eslint-disable @typescript-eslint/require-await -- Scripted external contracts retain asynchronous signatures. */
import assert from "node:assert/strict";
import { readdir, rm, writeFile, readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { stringify } from "yaml";

import { executeCli } from "../../src/cli.ts";
import { agent, createProject, validConfig } from "../support/cli-project.ts";
import { createCliDependencies } from "../support/cli-dependencies.ts";

const run = ["run", "--project", "demo", "--env", "fake", "--parent", "48"];

await test("invalid configuration fails before any external reads or delivery resources", async (t) => {
  const cases: [object, RegExp][] = [
    [{ repository: "invalid" }, /repository/],
    [{ checkout: "relative/repo" }, /checkout/],
    [{ issueList: [1, 1] }, /unique/],
    [{ issueList: [0] }, /positive/],
    [{ issueList: "1" }, /array/],
    [{ maxBatchSize: 0 }, /maxBatchSize/],
    [{ maxBatchSize: 1.5 }, /maxBatchSize/],
    [{ targetBranch: " " }, /targetBranch/],
    [{ operationRetry: -1 }, /operationRetry/],
    [{ agentRetry: 0.5 }, /agentRetry/],
    [{ operationRetryDelay: [] }, /operationRetryDelay/],
    [{ agentRetryDelay: [0] }, /agentRetryDelay/],
    [{ ticketClosure: "agent" }, /ticketClosure/],
    [{ workflow: { review: "false" } }, /workflow.review/],
    [{ workflow: { maxReviewRounds: 0 } }, /maxReviewRounds/],
    [
      { workflow: { docMaintainTriggerLabel: false } },
      /docMaintainTriggerLabel/,
    ],
    [{ workflow: { reviewRounds: 1 } }, /unknown field/],
    [{ terminal: { backend: "fake" } }, /unknown field terminal/],
    [{ agentPause: true }, /unknown field agentPause/],
    [
      {
        agents: {
          ...validConfig.agents,
          implement: { agent: "codex", model: "model" },
        },
      },
      /unknown field agent/,
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
      {
        agents: {
          ...validConfig.agents,
          implement: { ...agent, reasoningEffort: "high" },
        },
      },
      /unknown field/,
    ],
    [
      { agents: { ...validConfig.agents, extra: agent } },
      /unknown field extra/,
    ],
    [
      { tracker: { ...validConfig.tracker, tokenEnv: "MISSING" } },
      /missing credential MISSING/,
    ],
    [
      { tracker: { ...validConfig.tracker, extra: true } },
      /unknown field extra/,
    ],
    [
      { codeHost: { ...validConfig.codeHost, adminMerge: "true" } },
      /adminMerge/,
    ],
    [
      { timeouts: { ...validConfig.timeouts, agentMinutes: 0 } },
      /agentMinutes/,
    ],
    [
      { timeouts: { ...validConfig.timeouts, agentIdleMinutes: -1 } },
      /agentIdleMinutes/,
    ],
    [
      { timeouts: { ...validConfig.timeouts, requiredChecksMinutes: 0 } },
      /requiredChecksMinutes/,
    ],
    [
      { timeouts: { ...validConfig.timeouts, mergeQueueMinutes: 0 } },
      /mergeQueueMinutes/,
    ],
    [
      { timeouts: { ...validConfig.timeouts, pause: true } },
      /unknown field pause/,
    ],
    [{ maintenanceTicket: { obsolete: true } }, /unknown field obsolete/],
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
    assert.match(result.summary.reasons.join(" "), expected);
    assert.equal(result.logPath, null);
    assert.deepEqual(deps.effects, []);
    assert.deepEqual(deps.reads, []);
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
      ["run", "--env", "fake", "--project", project, "--parent", "48"],
      deps,
    );
    assert.equal(result.exitCode, 1);
    assert.deepEqual(deps.reads, []);
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
    (await executeCli(run, createCliDependencies(root))).summary.reasons.join(
      " ",
    ),
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
      (await executeCli(run, createCliDependencies(root))).summary.reasons.join(
        " ",
      ),
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
      (await executeCli(run, createCliDependencies(root))).summary.reasons.join(
        " ",
      ),
      new RegExp(`maintenanceTicket.${field}`),
    );
  }
  await writeFile(path.join(directory, "config.yaml"), stringify(config));
  await rm(path.join(directory, "prompts/documentation.md"));
  assert.match(
    (await executeCli(run, createCliDependencies(root))).summary.reasons.join(
      " ",
    ),
    /Documentation Maintenance is enabled/,
  );
});

await test("Run modes are exclusive and auto-merge is restricted before external access", async (t) => {
  const { root } = await createProject(t);
  const prefix = ["run", "--project", "demo", "--env", "fake"];
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
  ]) {
    const deps = createCliDependencies(root);
    assert.equal(
      (await executeCli([...prefix, ...scope], deps)).exitCode,
      1,
      scope.join(" "),
    );
    assert.deepEqual(deps.reads, []);
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
    ["run", "--parent", "48", "--env", "fake", "--project", "demo"],
    deps,
  );
  assert.equal(result.summary.outcome, "no_work");
  assert.equal(result.summary.targetBranch, "release");
  assert.match(result.summary.reasons.join(" "), /2, 7/);
});

await test("accepted later scopes validate configuration and report incomplete without dispatch", async (t) => {
  const { root, directory } = await createProject(t, {
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
      ["run", "--env", "fake", "--project", "demo", ...scope],
      deps,
    );
    assert.equal(result.summary.outcome, "incomplete");
    assert.deepEqual(deps.effects, []);
  }
  const document = [
    "run",
    "--env",
    "fake",
    "--project",
    "demo",
    "--document",
    "--no-auto-merge",
  ];
  assert.equal(
    (await executeCli(document, createCliDependencies(root))).summary.outcome,
    "failed",
  );
  await writeFile(
    path.join(directory, "config.yaml"),
    stringify({
      ...validConfig,
      agents: { ...validConfig.agents, documentation: agent },
      maintenanceTicket: {
        title: "Docs",
        body: "Update",
        label: "doc-maintain",
      },
    }),
  );
  assert.equal(
    (await executeCli(document, createCliDependencies(root))).summary.outcome,
    "incomplete",
  );
});
