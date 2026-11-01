import assert from "node:assert/strict";
import { access } from "node:fs/promises";
import test from "node:test";
import { documentationRun } from "../support/documentation-run.ts";
import { publish } from "../support/implementation-run.ts";

const noChange = {
  outcome: "no_change",
  summary: "Documentation is current",
  commits: [],
  findings_file: null,
};

await test("standalone documentation delivers a Maintenance Ticket without business selection or ordinary Review", async (t) => {
  const fixture = await documentationRun(t);
  const result = await fixture.run();
  assert.equal(result.summary.outcome, "succeeded", JSON.stringify(result));
  assert.equal(fixture.maintenance.creates, 1);
  assert.equal(fixture.state.probeCount, 1);
  assert.equal(fixture.state.taskCount, 1);
  assert.equal(fixture.publicationState.creations, 1);
  assert.equal(fixture.integrationState.requests.length, 1);
  assert.equal(fixture.integrationState.closures, 1);
  assert.equal(fixture.state.closedTabs.length, 1);
  assert.equal(fixture.state.submissions[0]!.text, "document-cli");
  const progress = await fixture.snapshot();
  assert.equal(progress.roles.implement, undefined);
  assert.equal(progress.reviews, undefined);
  assert.equal(progress.publication?.phase, "delivered");
  assert.deepEqual(fixture.maintenance.cleanup, [progress.worktree]);
  await assert.rejects(access(progress.invocation!.path), { code: "ENOENT" });
});

await test("verified documentation no_change closes without a PR even with no-auto-merge and code_host closure", async (t) => {
  const fixture = await documentationRun(t, "code_host");
  fixture.state.onTask = async (file) => {
    fixture.state.evidence.changed = false;
    await publish(file, noChange);
  };
  const result = await fixture.run(["--no-auto-merge"]);
  assert.equal(result.summary.outcome, "succeeded", JSON.stringify(result));
  assert.equal(fixture.publicationState.pushes, 0);
  assert.equal(fixture.publicationState.creations, 0);
  assert.equal(fixture.integrationState.requests.length, 0);
  assert.equal(fixture.integrationState.closures, 1);
  assert.equal(fixture.state.closedTabs.length, 1);
  assert.equal((await fixture.snapshot()).noChangeClosure, "completed");
  assert.equal(fixture.maintenance.cleanup.length, 1);
  assert.equal(result.exitCode, 0);
  assert.equal(result.summary.tickets?.[0]?.kind, "maintenance");
  assert.equal(result.summary.tickets?.[0]?.status, "no_change");
  assert.deepEqual(result.summary.tickets?.[0]?.retainedWorktrees, []);
  const previous = await fixture.snapshot();
  assert.equal(
    (await fixture.run(["--no-auto-merge"])).summary.outcome,
    "succeeded",
  );
  assert.equal(fixture.maintenance.creates, 2);
  const next = await fixture.snapshot();
  assert.notEqual(next.ticket, previous.ticket);
  assert.notEqual(next.execution_id, previous.execution_id);
  assert.notEqual(next.run_id, previous.run_id);
});

await test("a documentation Probe written while stopped is accepted before exact conversation resume", async (t) => {
  const fixture = await documentationRun(t);
  const probe = fixture.state.onProbe;
  fixture.state.onProbe = async (assignment) => {
    await probe(assignment);
    fixture.controller.abort();
  };
  assert.equal((await fixture.run()).summary.outcome, "cancelled");
  const before = await fixture.snapshot();
  fixture.dependencies.signal = new AbortController().signal;
  const result = await fixture.run();
  assert.equal(result.summary.outcome, "succeeded", JSON.stringify(result));
  assert.equal((await fixture.snapshot()).execution_id, before.execution_id);
  assert.equal(fixture.state.probeCount, 1);
  assert.equal(fixture.state.taskCount, 1);
  assert.equal(fixture.maintenance.creates, 1);
});

await test("no_change with actual changes is corrected before closure and cleanup", async (t) => {
  const fixture = await documentationRun(t);
  fixture.state.onTask = (file) => publish(file, noChange);
  fixture.state.onCorrection = async (file) => {
    assert.equal(fixture.integrationState.closures, 0);
    assert.equal(fixture.maintenance.cleanup.length, 0);
    fixture.state.evidence.changed = false;
    await publish(file, noChange);
  };
  assert.equal((await fixture.run()).summary.outcome, "succeeded");
  const saved = await fixture.snapshot();
  assert.equal(saved.corrections, 1);
  assert.equal(saved.superseded.length, 1);
  assert.equal(fixture.integrationState.closures, 1);
  assert.equal(fixture.publicationState.creations, 0);
});

await test("no-auto-merge documentation retains the PR, Worktree, and handoffs without closing", async (t) => {
  const fixture = await documentationRun(t);
  assert.equal(
    (await fixture.run(["--no-auto-merge"])).summary.outcome,
    "incomplete",
  );
  const progress = await fixture.snapshot();
  assert.equal(progress.publication?.phase, "checks_ready");
  await access(progress.worktree);
  await access(progress.invocation!.path);
  assert.equal(fixture.state.closedTabs.length, 1);
  assert.equal(fixture.integrationState.requests.length, 0);
  assert.equal(fixture.integrationState.closures, 0);
  assert.equal(fixture.maintenance.cleanup.length, 0);
  assert.equal(
    (await fixture.run(["--no-auto-merge"])).summary.outcome,
    "incomplete",
  );
  assert.equal(fixture.publicationState.creations, 1);
  assert.equal(fixture.state.taskCount, 1);
});
