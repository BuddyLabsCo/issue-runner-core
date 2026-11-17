import assert from "node:assert/strict";
import test from "node:test";
import { child, parentRun } from "../support/parent-run.ts";

for (const applied of ["both", "label", "runner"] as const) {
  await test(`uncertain ${applied} Reservation effects are reconciled from a fresh read`, async (t) => {
    const ticket = child(51, {
      labels: ["ready-for-agent", "unrelated"],
      assignees: [],
    });
    const fixture = await parentRun(t, [ticket]);
    const reserve = fixture.dependencies.tracker.reserveStart.bind(
      fixture.dependencies.tracker,
    );
    const observe = fixture.dependencies.tracker.observeStart.bind(
      fixture.dependencies.tracker,
    );
    const writes: { label: boolean; runner: boolean }[] = [];
    let reads = 0;
    fixture.dependencies.tracker.observeStart = async (input) => {
      reads++;
      return observe(input);
    };
    fixture.dependencies.tracker.reserveStart = async (input) => {
      writes.push({ label: !!input.labelId, runner: !!input.runnerId });
      if (writes.length === 1) {
        if (applied !== "runner") ticket.labels!.push(input.label);
        if (applied !== "label") ticket.assignees!.push(input.runner);
        throw new Error("response lost");
      }
      return reserve(input);
    };
    await fixture.run();
    assert.ok(reads >= 2);
    assert.deepEqual(
      writes,
      applied === "both"
        ? [{ label: true, runner: true }]
        : [
            { label: true, runner: true },
            { label: applied === "runner", runner: applied === "label" },
          ],
    );
    assert.ok(ticket.labels!.includes("unrelated"));
    assert.deepEqual(fixture.dispatched, [51]);
  });
}
