/* eslint-disable @typescript-eslint/require-await -- Scripted external boundaries. */
import assert from "node:assert/strict";
import test from "node:test";
import { implementationRun, publish } from "../support/implementation-run.ts";

await test("unexpected Probe fields cannot establish identity or dispatch implementation", async (t) => {
  const fixture = await implementationRun(t);
  fixture.state.onProbe = async (assignment) => {
    await publish(String(assignment.path), {
      ticket: 999,
      sessionid: "native-identity",
      pr_title: "title",
      pr_body: "body",
    });
  };
  fixture.state.onSleep = async (ms) => {
    if (ms === 250) fixture.controller.abort();
  };
  assert.equal((await fixture.run()).summary.outcome, "cancelled");
  assert.equal(fixture.state.taskCount, 0);
  assert.equal((await fixture.snapshot()).roles.implement, undefined);
  assert.equal(fixture.state.events.includes("close"), false);
  assert.match(
    fixture.dependencies.messages.join("\n"),
    /Probe requires actual native identity/,
  );
});

for (const invalid of ["pr_title", "pr_body"] as const) {
  await test(`Probe rejects invalid ${invalid} before task submission`, async (t) => {
    const fixture = await implementationRun(t);
    fixture.state.onProbe = async (assignment) => {
      await publish(String(assignment.path), {
        sessionid: "native-session",
        pr_title: "Title",
        pr_body: "Body",
        [invalid]: "",
      });
    };
    fixture.state.onSleep = async (ms) => {
      if (ms === 250) fixture.controller.abort();
    };
    assert.equal((await fixture.run()).summary.outcome, "cancelled");
    assert.equal(fixture.state.taskCount, 0);
    assert.equal((await fixture.snapshot()).roles.implement, undefined);
  });
}
