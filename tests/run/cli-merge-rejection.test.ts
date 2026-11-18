/* eslint-disable @typescript-eslint/require-await -- Scripted external boundary. */
import assert from "node:assert/strict";
import test from "node:test";
import { conflictRepairRun } from "../support/conflict-repair-run.ts";
import { repairCommit } from "../support/ci-repair-run.ts";

await test("a rejected merge enters repair only after fresh conflict evidence", async (t) => {
  const fixture = await conflictRepairRun(t);
  const observe = fixture.dependencies.codeHost.getPullRequest.bind(
    fixture.dependencies.codeHost,
  );
  fixture.dependencies.codeHost.getPullRequest = async (...args) => {
    if (fixture.publicationState.pushes > 1)
      fixture.conflictState.mergeable = "mergeable";
    return observe(...args);
  };
  fixture.conflictState.onMerge = async () => {
    if (fixture.conflictState.requests.length === 1) {
      fixture.conflictState.mergeable = "conflicting";
      return { outcome: "rejected", error: new Error("merge rejected") };
    }
    fixture.conflictState.merged = true;
    return { outcome: "accepted" };
  };
  assert.equal((await fixture.run()).summary.outcome, "succeeded");
  assert.equal(fixture.repairs.tasks.length, 1);
  assert.equal(
    fixture.conflictState.requests.at(-1)!.headSha,
    repairCommit.sha,
  );
});
