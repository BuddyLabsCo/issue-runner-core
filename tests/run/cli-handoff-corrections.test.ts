import assert from "node:assert/strict";
import test from "node:test";
import { validConfig } from "../support/cli-project.ts";
import {
  committed,
  implementationRun,
  publish,
} from "../support/implementation-run.ts";

await test("execution findings receive a specific correction in the original conversation", async (t) => {
  const fixture = await implementationRun(t);
  fixture.state.onTask = async (file) => {
    fixture.state.evidence.commits = committed().commits;
    await publish(file, { ...committed(), findings_file: file });
  };
  fixture.state.onCorrection = async (file) => {
    const correction = fixture.state.submissions.at(-1)!;
    assert.match(correction.text, /Execution findings_file must be null/);
    assert.equal(correction.tab, fixture.state.submissions[2]!.tab);
    assert.equal(correction.chord, "Shift+Enter");
    assert.ok(correction.text.includes(JSON.stringify(file)));
    assert.equal((await fixture.snapshot()).phase, "implementing");
    assert.equal(fixture.state.closedTabs.length, 0);
    await publish(file, committed());
  };
  const result = await fixture.run();
  assert.equal(result.summary.outcome, "incomplete", JSON.stringify(result));
  assert.equal((await fixture.snapshot()).phase, "implementation_completed");
  assert.deepEqual(
    fixture.state.sleeps.filter((ms) => ms !== 30_000),
    [10_000, 2_000],
  );
});

await test("additional corrections persist unique assignments, reuse the final seconds delay, and stay exhausted during manual recovery", async (t) => {
  const fixture = await implementationRun(t, {
    ...validConfig,
    agentRetry: 3,
    agentRetryDelay: [0.5, 0.75],
  });
  const probe = fixture.state.onProbe;
  fixture.state.onProbe = async (assignment) => {
    if (fixture.state.probeCount === 1)
      await publish(String(assignment.path), { ...assignment, sessionid: "" });
    else await probe(assignment);
  };
  const paths: string[] = [];
  const invocations: string[] = [];
  fixture.state.onTask = async (file) => {
    paths.push(file);
    invocations.push((await fixture.snapshot()).invocation!.invocation_id);
    fixture.state.evidence.commits = committed().commits;
    await publish(file, {});
  };
  fixture.state.onCorrection = async (file) => {
    const saved = await fixture.snapshot();
    assert.equal(saved.corrections, paths.length);
    assert.equal(saved.probeRetries, 1);
    assert.equal(saved.phase, "implementing");
    assert.deepEqual(saved.superseded.slice(1), paths);
    assert.ok(
      fixture.dependencies.messages.some((line) => line.includes(file)),
    );
    const correction = fixture.state.submissions.at(-1)!;
    assert.equal(correction.tab, fixture.state.submissions[0]!.tab);
    assert.equal(correction.chord, "Shift+Enter");
    assert.equal(fixture.state.closedTabs.length, 0);
    paths.push(file);
    invocations.push(saved.invocation!.invocation_id);
    // Superseded valid files cannot satisfy the active assignment.
    await publish(paths[0]!, committed());
    await publish(file, { ...committed(), outcome: "blocked" });
  };
  let manualWrites = 0;
  fixture.state.onSleep = async (ms) => {
    if (ms === 500 || ms === 750) {
      const saved = await fixture.snapshot();
      assert.equal(saved.corrections, paths.length);
      assert.ok(!paths.includes(saved.invocation!.path));
      assert.ok(!invocations.includes(saved.invocation!.invocation_id));
      assert.equal(saved.phase, "implementing");
    }
    if (ms !== 250) return;
    const saved = await fixture.snapshot();
    assert.equal(saved.corrections, 3);
    assert.equal(saved.invocation!.path, paths[3]);
    assert.equal(saved.phase, "implementing");
    assert.equal(fixture.state.closedTabs.length, 0);
    assert.match(
      fixture.dependencies.messages.join("\n"),
      /Automatic correction budget exhausted.*manually.*current handoff path/u,
    );
    assert.ok(++manualWrites <= 3);
    await publish(
      paths[3]!,
      manualWrites < 3 ? { ...committed(), summary: "" } : committed(),
    );
  };
  const result = await fixture.run();
  assert.equal(result.summary.outcome, "incomplete", JSON.stringify(result));
  const saved = await fixture.snapshot();
  assert.equal(saved.phase, "implementation_completed");
  assert.equal(saved.corrections, 3);
  assert.equal(saved.probeRetries, 1);
  assert.equal(paths.length, 4);
  assert.equal(new Set(paths).size, 4);
  assert.equal(new Set(invocations).size, 4);
  assert.equal(manualWrites, 3);
  assert.deepEqual(
    fixture.state.sleeps.filter((ms) => ms !== 30_000),
    [10_000, 1_000, 500, 750, 750, 250, 250, 250],
  );
  assert.equal(fixture.state.submissions.length, 7);
  assert.equal(fixture.state.taskCount, 1);
  assert.equal(fixture.state.probeCount, 2);
  assert.equal(fixture.state.closedTabs.length, 1);
});

for (const [mismatch, reason] of [
  ["branch", /Delivery branch mismatch/u],
  ["base", /Base SHA mismatch/u],
  ["worktree", /Worktree path mismatch/u],
  ["clean", /Worktree must be clean/u],
  ["commits", /Claimed commits do not match actual Git commits/u],
  ["changed", /no actual changes/u],
] as const) {
  await test(`false Git ${mismatch} claims receive actionable corrections before acceptance`, async (t) => {
    const fixture = await implementationRun(t);
    const evidence = fixture.state.evidence;
    fixture.state.onTask = async (file) => {
      evidence.commits = structuredClone(committed().commits);
      const correct = structuredClone(evidence);
      if (mismatch === "clean" || mismatch === "changed")
        evidence[mismatch] = false;
      else if (mismatch === "commits")
        evidence.commits[0]!.message = "Incorrect message";
      else evidence[mismatch] = "wrong";
      fixture.state.onCorrection = async (correctedPath) => {
        assert.match(fixture.state.submissions.at(-1)!.text, reason);
        assert.equal((await fixture.snapshot()).phase, "implementing");
        assert.equal(fixture.state.closedTabs.length, 0);
        Object.assign(evidence, correct);
        await publish(correctedPath, committed());
      };
      await publish(file, committed());
    };
    const result = await fixture.run();
    assert.equal(result.summary.outcome, "incomplete", JSON.stringify(result));
    assert.equal((await fixture.snapshot()).phase, "implementation_completed");
    assert.equal((await fixture.snapshot()).corrections, 1);
  });
}
