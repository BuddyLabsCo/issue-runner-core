/* eslint-disable @typescript-eslint/require-await -- Scripted external boundaries. */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { access, readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { executeCli } from "../../src/cli.ts";
import {
  committed,
  implementationCommand,
  implementationRun,
  publish,
} from "../support/implementation-run.ts";
import { validConfig } from "../support/cli-project.ts";

await test("a retained implementation resumes only its saved role with literal all-occurrence session substitution", async (t) => {
  const fixture = await implementationRun(t, {
    ...validConfig,
    agents: {
      ...validConfig.agents,
      implement: {
        ...validConfig.agents.implement,
        resume: 'any-cli --resume "{sessionref}" --same "{sessionref}"',
      },
    },
  });
  fixture.state.onTask = async () => {
    /* Leave the invocation unfinished. */
  };
  fixture.state.onSleep = async (ms) => {
    if (ms === 250) fixture.controller.abort();
  };
  assert.equal((await fixture.run()).summary.outcome, "cancelled");
  const saved = await fixture.snapshot();
  // Compatibility oracle: the argument/config bytes used before hashing moved.
  const legacyHash = createHash("sha256")
    .update(JSON.stringify(implementationCommand))
    .update(await readFile(path.join(fixture.directory, "config.yaml")))
    .digest("hex");
  await access(
    path.join(fixture.directory, "recovery", `${legacyHash}-50.json`),
  );
  const controller = new AbortController();
  const before = fixture.state.submissions.length;
  fixture.state.onSleep = async (ms) => {
    if (ms === 250) await publish(saved.invocation!.path, committed());
  };
  fixture.state.evidence.commits = committed().commits;
  const result = await executeCli(implementationCommand, {
    ...fixture.dependencies,
    signal: controller.signal,
  });
  assert.equal(result.summary.outcome, "incomplete");
  const resumed = fixture.state.submissions.slice(before);
  assert.equal(
    resumed[0]?.text,
    'any-cli --resume "native/$&/$`/$\'/session" --same "native/$&/$`/$\'/session"',
  );
  assert.equal(resumed[0]?.chord, "Enter");
  assert.deepEqual(
    resumed.slice(1).map((submission) => submission.text),
    ["continue"],
  );
  assert.equal(fixture.state.probeCount, 1);
  assert.equal(fixture.state.taskCount, 1);
  assert.equal((await fixture.snapshot()).execution_id, saved.execution_id);
  assert.equal(
    (await fixture.snapshot()).invocation?.path,
    saved.invocation?.path,
  );
  assert.equal((await fixture.snapshot()).pr_body, saved.pr_body);
});

await test("a durably completed implementation is verified without dispatching another native stage", async (t) => {
  const fixture = await implementationRun(t);
  assert.equal((await fixture.run()).summary.outcome, "incomplete");
  const before = fixture.state.submissions.length;
  assert.equal((await fixture.run()).summary.outcome, "incomplete");
  assert.equal(fixture.state.submissions.length, before);
  assert.equal(fixture.state.taskCount, 1);
});

await test("a valid result produced while Runner was stopped completes without opening a native tab", async (t) => {
  const fixture = await implementationRun(t);
  fixture.state.onTask = async () => {
    /* Leave the assigned invocation unfinished. */
  };
  fixture.state.onSleep = async (ms) => {
    if (ms === 250) fixture.controller.abort();
  };
  assert.equal((await fixture.run()).summary.outcome, "cancelled");
  const saved = await fixture.snapshot();
  await publish(saved.invocation!.path, committed());
  fixture.state.evidence.commits = committed().commits;
  const before = fixture.state.submissions.length;
  const sleeps = fixture.state.sleeps.length;
  let opens = 0;
  const result = await executeCli(implementationCommand, {
    ...fixture.dependencies,
    signal: new AbortController().signal,
    terminalPlugin: {
      ...fixture.dependencies.terminalPlugin,
      async createTab() {
        opens += 1;
        throw new Error("native terminal unavailable");
      },
    },
  });
  assert.equal(result.summary.outcome, "incomplete", JSON.stringify(result));
  assert.equal(opens, 0);
  assert.equal(fixture.state.submissions.length, before);
  assert.equal(fixture.state.sleeps.length, sleeps);
  const accepted = await fixture.snapshot();
  assert.equal(accepted.phase, "implementation_completed");
  assert.deepEqual(accepted.result?.commits, committed().commits);
  assert.equal(accepted.invocation?.path, saved.invocation?.path);
  assert.equal(accepted.pr_body, saved.pr_body);
});

await test("invalid retained output resumes only for correction and keeps its implementation assignment", async (t) => {
  const fixture = await implementationRun(t);
  fixture.state.onTask = async () => {
    /* Leave the invocation unfinished. */
  };
  fixture.state.onSleep = async (ms) => {
    if (ms === 250) fixture.controller.abort();
  };
  assert.equal((await fixture.run()).summary.outcome, "cancelled");
  const saved = await fixture.snapshot();
  await publish(saved.invocation!.path, { ...committed(), checks: [] });
  fixture.state.evidence.commits = committed().commits;
  const before = fixture.state.submissions.length;
  assert.equal(
    (
      await executeCli(implementationCommand, {
        ...fixture.dependencies,
        signal: new AbortController().signal,
      })
    ).summary.outcome,
    "incomplete",
  );
  const resumed = fixture.state.submissions.slice(before);
  assert.equal(resumed.length, 2);
  assert.match(resumed[0]!.text, /--resume/);
  assert.match(resumed[1]!.text, /^Correct the implementation handoff:/);
  assert.equal(resumed[1]?.chord, "Shift+Enter");
  const accepted = await fixture.snapshot();
  assert.notEqual(accepted.invocation?.path, saved.invocation?.path);
  assert.deepEqual(accepted.superseded, [saved.invocation!.path]);
  assert.equal(accepted.corrections, 1);
  assert.equal(accepted.execution_id, saved.execution_id);
  assert.equal(fixture.state.taskCount, 1);
});

await test("exhausted retained output can be corrected manually without reopening a native tab", async (t) => {
  const fixture = await implementationRun(t, { ...validConfig, agentRetry: 0 });
  fixture.state.onTask = async () => {
    /* Leave the invocation unfinished. */
  };
  fixture.state.onSleep = async (ms) => {
    if (ms === 250) fixture.controller.abort();
  };
  assert.equal((await fixture.run()).summary.outcome, "cancelled");
  const saved = await fixture.snapshot();
  await publish(saved.invocation!.path, { ...committed(), checks: [] });
  fixture.state.evidence.commits = committed().commits;
  fixture.state.onSleep = async (ms) => {
    if (ms === 250) await publish(saved.invocation!.path, committed());
  };
  const result = await executeCli(implementationCommand, {
    ...fixture.dependencies,
    signal: new AbortController().signal,
    terminalPlugin: {
      ...fixture.dependencies.terminalPlugin,
      async createTab() {
        assert.fail("manual file correction does not require a tab");
      },
    },
  });
  assert.equal(result.summary.outcome, "incomplete");
  assert.equal((await fixture.snapshot()).phase, "implementation_completed");
  assert.equal(
    (await fixture.snapshot()).invocation?.path,
    saved.invocation?.path,
  );
});

await test("a consumed nonzero correction budget stays exhausted across restart and invalid manual writes", async (t) => {
  const fixture = await implementationRun(t, { ...validConfig, agentRetry: 1 });
  fixture.state.onTask = async (file) => {
    fixture.state.evidence.commits = committed().commits;
    await publish(file, {});
  };
  fixture.state.onCorrection = async (file) => {
    await publish(file, { ...committed(), findings_file: file });
  };
  fixture.state.onSleep = async (ms) => {
    if (ms === 250) fixture.controller.abort();
  };
  assert.equal((await fixture.run()).summary.outcome, "cancelled");
  const saved = await fixture.snapshot();
  assert.equal(saved.corrections, 1);
  const before = fixture.state.submissions.length;
  let polls = 0;
  fixture.state.onSleep = async (ms) => {
    assert.equal(ms, 250);
    assert.ok(++polls <= 2);
    assert.equal((await fixture.snapshot()).corrections, 1);
    await publish(
      saved.invocation!.path,
      polls === 1 ? { ...committed(), outcome: "blocked" } : committed(),
    );
  };
  const result = await executeCli(implementationCommand, {
    ...fixture.dependencies,
    signal: new AbortController().signal,
    terminalPlugin: {
      ...fixture.dependencies.terminalPlugin,
      async createTab() {
        assert.fail("exhaustion must not dispatch automatic corrections");
      },
    },
  });
  assert.equal(result.summary.outcome, "incomplete", JSON.stringify(result));
  assert.equal(fixture.state.submissions.length, before);
  const accepted = await fixture.snapshot();
  assert.equal(accepted.phase, "implementation_completed");
  assert.equal(accepted.corrections, 1);
  assert.deepEqual(accepted.invocation, saved.invocation);
  assert.deepEqual(accepted.superseded, saved.superseded);
  assert.equal(accepted.execution_id, saved.execution_id);
  assert.equal(accepted.pr_body, saved.pr_body);
});
