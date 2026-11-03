/* eslint-disable @typescript-eslint/require-await -- Scripted external boundaries. */
import assert from "node:assert/strict";
import test from "node:test";
import {
  committed,
  implementationRun,
  publish,
} from "../support/implementation-run.ts";

await test("unexpected Probe fields cannot establish identity or dispatch implementation", async (t) => {
  const fixture = await implementationRun(t);
  fixture.state.onProbe = async (assignment) => {
    if (fixture.state.probeCount > 1) return;
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
  await test(`business handoff rejects invalid ${invalid} and corrects it before publication`, async (t) => {
    const fixture = await implementationRun(t);
    fixture.dependencies.terminalPlugin.start = async () => "native-session";
    fixture.state.onTask = async (file) => {
      fixture.state.evidence.commits = committed().commits;
      await publish(file, {
        ...committed(),
        [invalid]: "",
      });
    };
    let corrections = 0;
    fixture.state.onCorrection = async (file) => {
      assert.equal((await fixture.snapshot()).publication, undefined);
      assert.equal((await fixture.snapshot()).pr_title, undefined);
      corrections++;
      await publish(file, committed());
    };
    assert.match((await fixture.run()).summary.reasons.join(" "), /CI-ready/);
    assert.equal(fixture.state.taskCount, 1);
    assert.equal(corrections, 1);
    assert.equal(fixture.state.probeCount, 0);
    assert.equal(
      (await fixture.snapshot()).publication?.title,
      committed().pr_title,
    );
  });
}
