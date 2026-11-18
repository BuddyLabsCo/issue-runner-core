/* eslint-disable @typescript-eslint/require-await -- Scripted external boundaries. */
import assert from "node:assert/strict";
import test from "node:test";
import { repairCommit } from "../support/ci-repair-run.ts";
import { conflictRepairRun } from "../support/conflict-repair-run.ts";

await test("a rejected merge followed by explicit conflict evidence starts repair", async (t) => {
  const fixture = await conflictRepairRun(t);
  fixture.conflictState.onMerge = async () => {
    if (fixture.publicationState.pushes === 1) {
      fixture.conflictState.mergeable = "conflicting";
      return { outcome: "rejected", error: new Error("merge rejected") };
    }
    fixture.conflictState.merged = true;
    return { outcome: "accepted" };
  };
  const repair = fixture.repairs.onTask;
  fixture.repairs.onTask = async (...args) => {
    await repair(...args);
    fixture.conflictState.mergeable = "mergeable";
  };
  assert.equal((await fixture.run()).summary.outcome, "succeeded");
  assert.equal(fixture.conflictState.requests.length, 2);
  assert.equal(fixture.conflictState.requests[1]!.headSha, repairCommit.sha);
});
