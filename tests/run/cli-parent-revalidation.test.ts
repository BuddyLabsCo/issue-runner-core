/* eslint-disable @typescript-eslint/require-await -- Scripted external boundaries. */
import assert from "node:assert/strict";
import test from "node:test";
import { child, parentDeliveryRun, parentRun } from "../support/parent-run.ts";

await test("parent cancellation after a failed assignee write prevents its retry mutation", async (t) => {
  const fixture = await parentRun(t, [child(51)]);
  let cancelled = false;
  let attempts = 0;
  fixture.dependencies.tracker.getParent = async () => ({
    number: 48,
    state: cancelled ? "closed" : "open",
    stateReason: cancelled ? "not_planned" : null,
  });
  const addAssignee = fixture.dependencies.tracker.addAssignee.bind(
    fixture.dependencies.tracker,
  );
  fixture.dependencies.tracker.addAssignee = async (...args) => {
    attempts += 1;
    if (attempts === 1) {
      cancelled = true;
      throw new Error("assignee request failed");
    }
    await addAssignee(...args);
  };
  const result = await fixture.run();
  assert.equal(result.summary.outcome, "cancelled");
  assert.equal(attempts, 1);
  assert.deepEqual(fixture.writes, ["label:51"]);
  assert.deepEqual(fixture.dispatched, []);
});

for (const operation of ["addLabel", "addAssignee"] as const) {
  for (const change of ["cancelled", "ownership"] as const) {
    await test(`${operation} retry stops when eligibility becomes ${change} during backoff`, async (t) => {
      const ticket = child(51);
      const fixture = await parentDeliveryRun(t, [ticket]);
      let changed = false;
      let attempts = 0;
      fixture.dependencies.tracker.getParent = async () => ({
        number: 48,
        state:
          changed && change === "cancelled" ? "closed" : fixture.parent.state,
        stateReason:
          changed && change === "cancelled"
            ? "not_planned"
            : fixture.parent.stateReason,
      });
      const write = fixture.dependencies.tracker[operation].bind(
        fixture.dependencies.tracker,
      );
      fixture.dependencies.tracker[operation] = async (...args) => {
        attempts += 1;
        if (attempts === 1) throw new Error("request failed before writing");
        await write(...args);
      };
      fixture.dependencies.clock.sleep = async (ms) => {
        assert.equal(ms, 1000);
        changed = true;
        if (change === "ownership") {
          ticket.assignees = ["developer"];
        }
      };
      const result = await fixture.run();
      assert.equal(
        result.summary.outcome,
        change === "cancelled" ? "cancelled" : "incomplete",
      );
      assert.equal(attempts, 1);
      assert.deepEqual(fixture.dispatched, []);
      assert.deepEqual(
        fixture.writes,
        operation === "addLabel" ? [] : ["label:51"],
      );
    });
  }
}
