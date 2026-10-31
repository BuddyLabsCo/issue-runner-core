/* eslint-disable @typescript-eslint/require-await -- Scripted external boundaries. */
import assert from "node:assert/strict";
import { mkdir, readdir, rename, rm } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { executeCli } from "../../src/cli.ts";
import { validConfig } from "../support/cli-project.ts";
import {
  committed,
  implementationCommand,
  implementationRun,
  publish,
} from "../support/implementation-run.ts";
import { reviewRun } from "../support/review-run.ts";

await test("restart reprocesses a verified handoff when completion persistence failed", async (t) => {
  const fixture = await implementationRun(t, {
    ...validConfig,
    operationRetry: 0,
  });
  const inspect = fixture.dependencies.gitWorkspace.inspect.bind(
    fixture.dependencies.gitWorkspace,
  );
  let validations = 0;
  let obstruction = "";
  fixture.dependencies.gitWorkspace.inspect = async (input) => {
    const evidence = await inspect(input);
    if (fixture.state.taskCount && !(await fixture.snapshot()).result) {
      validations += 1;
      const recovery = path.join(fixture.directory, "recovery");
      const [file] = await readdir(recovery);
      obstruction = path.join(recovery, `${file!}.tmp`);
      await mkdir(obstruction);
    }
    return evidence;
  };
  fixture.dependencies.operator.pause = async (message) => {
    assert.ok(message.includes(obstruction));
    return "q";
  };
  assert.equal((await fixture.run()).summary.outcome, "cancelled");
  const saved = await fixture.snapshot();
  assert.equal(saved.phase, "implementing");
  assert.equal(saved.result, undefined);
  assert.equal(validations, 1);
  assert.equal(fixture.state.closedTabs.length, 0);
  await rm(obstruction, { recursive: true });
  fixture.dependencies.gitWorkspace.inspect = async (input) => {
    const evidence = await inspect(input);
    if (!(await fixture.snapshot()).result) validations += 1;
    return evidence;
  };
  const result = await executeCli(implementationCommand, {
    ...fixture.dependencies,
    signal: new AbortController().signal,
    terminalPlugin: {
      async createTab() {
        assert.fail(
          "the retained final must be verified before native dispatch",
        );
      },
      async submitText() {
        assert.fail("recovery must not replay the assignment");
      },
      async closeTab() {
        assert.fail("recovery must not close an old opaque handle");
      },
    },
  });
  assert.match(result.summary.reasons.join(" "), /CI-ready/u);
  assert.equal(validations, 2);
  const recovered = await fixture.snapshot();
  assert.deepEqual(recovered.result, committed());
  assert.deepEqual(recovered.invocation, saved.invocation);
  assert.deepEqual(recovered.roles, saved.roles);
  assert.equal(recovered.execution_id, saved.execution_id);
  assert.equal(recovered.pr_title, saved.pr_title);
  assert.equal(recovered.pr_body, saved.pr_body);
  assert.equal(fixture.state.probeCount, 1);
  assert.equal(fixture.state.taskCount, 1);
});

await test("restart after durable completion skips the old stage and starts the next Review", async (t) => {
  const fixture = await reviewRun(t, 1);
  fixture.state.onClose = async () => fixture.controller.abort();
  assert.equal((await fixture.run()).summary.outcome, "cancelled");
  const saved = await fixture.snapshot();
  assert.equal(saved.phase, "implementation_completed");
  assert.deepEqual(saved.result, committed());
  assert.equal(saved.reviews, undefined);
  await rm(saved.invocation!.path);
  await rm(saved.probe!.path);
  const oldTab = fixture.state.submissions[0]!.tab;
  const before = fixture.state.submissions.length;
  const close = fixture.dependencies.terminalPlugin.closeTab.bind(
    fixture.dependencies.terminalPlugin,
  );
  fixture.dependencies.terminalPlugin.closeTab = async (tab) => {
    assert.notEqual(tab, oldTab);
    await close(tab);
  };
  const result = await executeCli(implementationCommand, {
    ...fixture.dependencies,
    signal: new AbortController().signal,
  });
  assert.match(result.summary.reasons.join(" "), /CI-ready/u);
  const resumed = fixture.state.submissions.slice(before);
  assert.equal(resumed.length, 3);
  assert.equal(resumed[0]!.text, "review-cli start");
  assert.match(resumed[1]!.text, /^Session Probe\n/u);
  assert.match(resumed[2]!.text, /^Review assignment\n/u);
  assert.ok(resumed.every(({ tab }) => tab !== oldTab));
  assert.equal(fixture.state.taskCount, 1);
  assert.equal(fixture.reviewState.reviews.length, 1);
  const recovered = await fixture.snapshot();
  assert.equal(recovered.phase, "publication_eligible");
  assert.deepEqual(recovered.invocation, saved.invocation);
  assert.equal(recovered.pr_title, saved.pr_title);
  assert.equal(recovered.pr_body, saved.pr_body);
});

await test("restart ignores a superseded final and an active temporary file until the expected final is published", async (t) => {
  const fixture = await implementationRun(t);
  fixture.state.onTask = async (file) => {
    fixture.state.evidence.commits = committed().commits;
    await publish(file, {});
  };
  fixture.state.onCorrection = async (file) => {
    await publish(`${file}.tmp`, {
      ...committed(),
      summary: "Active correction completed while stopped.",
    });
  };
  fixture.state.onSleep = async (ms) => {
    if (ms === 250) fixture.controller.abort();
  };
  assert.equal((await fixture.run()).summary.outcome, "cancelled");
  const saved = await fixture.snapshot();
  assert.equal(saved.corrections, 1);
  assert.equal(saved.superseded.length, 1);
  await publish(saved.superseded[0]!, committed());
  const before = fixture.state.submissions.length;
  let polls = 0;
  fixture.state.onSleep = async (ms) => {
    if (ms !== 250) return;
    assert.equal(++polls, 1);
    assert.equal((await fixture.snapshot()).result, undefined);
    await rename(`${saved.invocation!.path}.tmp`, saved.invocation!.path);
  };
  const result = await executeCli(implementationCommand, {
    ...fixture.dependencies,
    signal: new AbortController().signal,
  });
  assert.match(result.summary.reasons.join(" "), /CI-ready/u);
  assert.deepEqual(
    fixture.state.submissions.slice(before).map(({ text }) => text),
    ['any-cli --resume "native/$&/$`/$\'/session"', "continue"],
  );
  assert.equal(polls, 1);
  const recovered = await fixture.snapshot();
  assert.equal(
    recovered.result?.summary,
    "Active correction completed while stopped.",
  );
  assert.deepEqual(recovered.invocation, saved.invocation);
  assert.deepEqual(recovered.superseded, saved.superseded);
  assert.equal(recovered.corrections, 1);
  assert.equal(recovered.execution_id, saved.execution_id);
});
