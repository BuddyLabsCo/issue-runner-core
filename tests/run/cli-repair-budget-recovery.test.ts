/* eslint-disable @typescript-eslint/require-await -- Scripted external boundaries. */
import assert from "node:assert/strict";
import test from "node:test";
import { conflictRepairRun } from "../support/conflict-repair-run.ts";
import { failedCheck, repairCommit } from "../support/ci-repair-run.ts";
import { publish } from "../support/implementation-run.ts";

await test("conflict-to-CI recovery preserves separate exhausted budgets until category-specific authorization", async (t) => {
  const fixture = await conflictRepairRun(t);
  const noChange = {
    outcome: "no_change",
    summary: "No repair",
    commits: [],
    findings_file: null,
  };
  const repair = fixture.repairs.onTask;
  fixture.repairs.onTask = async (file, evidence) => {
    if (fixture.repairs.tasks.length === 1) await publish(file, noChange);
    else await repair(file, evidence);
  };
  fixture.publicationState.onChecks = async () =>
    fixture.publicationState.pushes === 2 ? [failedCheck] : [];
  fixture.scripts.ci.onTask = async (file) => {
    if (fixture.scripts.ci.tasks.length === 2) fixture.controller.abort();
    else await publish(file, noChange);
  };
  assert.equal((await fixture.run()).summary.outcome, "cancelled");
  const before = await fixture.snapshot();
  const conflict = before.publication!.conflictRepair!;
  assert.equal(conflict.consumed, 2);
  assert.equal(conflict.generation, 0);
  assert.equal(conflict.attempts[1]!.pushed, true);
  const ci = before.publication!.ciRepair!;
  assert.equal(ci.consumed, 1);
  assert.equal(ci.generation, 0);
  const pending = ci.attempts[1]!;
  assert.equal(pending.result, undefined);
  assert.equal(pending.sessionid, "ci-session-2");

  fixture.dependencies.signal = new AbortController().signal;
  fixture.scripts.ci.onTask = async (file) => publish(file, noChange);
  let pauses = 0;
  fixture.dependencies.operator.pause = async (message) => {
    assert.match(message, /CI repair failed after two attempts/u);
    pauses++;
    return "q";
  };
  assert.equal((await fixture.run()).summary.outcome, "cancelled");
  let saved = await fixture.snapshot();
  assert.deepEqual(saved.publication!.conflictRepair, conflict);
  assert.equal(saved.publication!.ciRepair!.consumed, 2);
  assert.equal(saved.publication!.ciRepair!.generation, 0);
  assert.deepEqual(
    saved.publication!.ciRepair!.attempts[1]!.invocation,
    pending.invocation,
  );
  assert.equal(
    saved.publication!.ciRepair!.attempts[1]!.sessionid,
    pending.sessionid,
  );
  assert.deepEqual(fixture.scripts.ci.continuations, ["continue"]);
  assert.equal(fixture.scripts.ci.tasks.length, 2);
  assert.equal(fixture.scripts.ci.probes.length, 2);
  assert.ok(
    fixture.state.submissions.some(({ text }) =>
      text.includes('--resume "ci-session-2"'),
    ),
  );

  assert.equal((await fixture.run()).summary.outcome, "cancelled");
  assert.equal(pauses, 2);
  assert.equal(fixture.scripts.ci.tasks.length, 2);
  fixture.dependencies.operator.pause = async (message) => {
    assert.match(message, /CI repair failed after two attempts/u);
    return "";
  };
  const ciCommit = { sha: "d".repeat(40), message: "fix: CI after conflict" };
  fixture.scripts.ci.onTask = async (file, evidence) => {
    assert.equal(evidence.base, repairCommit.sha);
    evidence.commits = [ciCommit];
    evidence.changed = true;
    await publish(file, {
      outcome: "committed",
      summary: "Fixed CI after conflict repair",
      commits: [ciCommit],
      findings_file: null,
    });
  };
  assert.equal((await fixture.run()).summary.outcome, "succeeded");
  saved = await fixture.snapshot();
  assert.deepEqual(saved.publication!.conflictRepair, conflict);
  assert.equal(saved.publication!.ciRepair!.consumed, 1);
  assert.equal(saved.publication!.ciRepair!.generation, 1);
  assert.deepEqual(
    saved.publication!.ciRepair!.attempts.map(({ generation }) => generation),
    [0, 0, 1],
  );
  assert.equal(saved.publication!.merge!.headSha, ciCommit.sha);
  assert.equal(saved.pr_title, before.pr_title);
  assert.equal(saved.pr_body, before.pr_body);
  assert.equal(fixture.publicationState.creations, 1);
  assert.equal(fixture.publicationState.pushes, 3);
  assert.equal(fixture.repairs.tasks.length, 2);
  assert.equal(fixture.scripts.ci.tasks.length, 3);
});
