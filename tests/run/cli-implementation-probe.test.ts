/* eslint-disable @typescript-eslint/require-await -- Scripted external boundaries. */
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { implementationRun, publish } from "../support/implementation-run.ts";
import { validConfig } from "../support/cli-project.ts";

await test("a superseded Probe ID cannot become native identity on a correlated retry", async (t) => {
  const fixture = await implementationRun(t);
  const ids: string[] = [];
  fixture.state.onProbe = async (assignment) => {
    ids.push(String(assignment.probe_id));
    await publish(String(assignment.path), {
      ...assignment,
      sessionid: ids[0],
      pr_title: "Title",
      pr_body: "Body",
    });
  };
  fixture.state.onSleep = async (ms) => {
    if (ms === 250) fixture.controller.abort();
  };
  assert.equal((await fixture.run()).summary.outcome, "cancelled");
  assert.equal(fixture.state.probeCount, 2);
  assert.notEqual(ids[0], ids[1]);
  assert.equal(fixture.state.taskCount, 0);
  const progress = await fixture.snapshot();
  assert.equal(progress.phase, "probing");
  assert.deepEqual(progress.probeIds, ids);
  assert.equal(progress.roles.implement, undefined);
  assert.equal(progress.pr_title, undefined);
});

await test("identity validation retains intermediate Probe IDs across multiple retries", async (t) => {
  const fixture = await implementationRun(t, {
    ...validConfig,
    operationRetry: 2,
  });
  const ids: string[] = [];
  fixture.state.onProbe = async (assignment) => {
    ids.push(String(assignment.probe_id));
    await publish(String(assignment.path), {
      ...assignment,
      sessionid: ids.length === 3 ? ids[1] : assignment.probe_id,
      pr_title: "Title",
      pr_body: "Body",
    });
  };
  fixture.state.onSleep = async (ms) => {
    if (ms === 250) fixture.controller.abort();
  };
  assert.equal((await fixture.run()).summary.outcome, "cancelled");
  assert.equal(fixture.state.probeCount, 3);
  assert.equal(fixture.state.taskCount, 0);
  const progress = await fixture.snapshot();
  assert.deepEqual(progress.probeIds, ids);
  assert.equal(progress.roles.implement, undefined);
});

await test("invalid Probes use their persisted operation budget and fresh assignments before implementation", async (t) => {
  const fixture = await implementationRun(t, {
    ...validConfig,
    operationRetry: 2,
    agentRetry: 0,
  });
  const assignments: Record<string, unknown>[] = [];
  fixture.state.onProbe = async (assignment) => {
    assignments.push(assignment);
    const progress = await fixture.snapshot();
    assert.equal(progress.probeRetries ?? 0, assignments.length - 1);
    assert.equal(progress.probe?.path, assignment.path);
    assert.deepEqual(
      progress.probeIds,
      assignments.map((assigned) => assigned.probe_id),
    );
    await publish(String(assignment.path), {
      ...assignment,
      sessionid:
        assignments.length < 3 ? assignment.probe_id : "actual-native-session",
      pr_title: "feat: [issue-50] implement the Issue",
      pr_body: "Implement the Issue.\n\nCloses #50",
    });
  };
  fixture.state.onSleep = async (ms) => {
    if (ms === 250) fixture.controller.abort();
  };
  const result = await fixture.run();
  assert.equal(result.summary.outcome, "incomplete", JSON.stringify(result));
  assert.equal(fixture.state.probeCount, 3);
  assert.equal(fixture.state.taskCount, 1);
  assert.deepEqual(fixture.state.sleeps, [10_000, 1_000, 1_000]);
  assert.equal(
    new Set(assignments.map((assignment) => assignment.path)).size,
    3,
  );
  assert.equal(
    new Set(assignments.map((assignment) => assignment.probe_id)).size,
    3,
  );
  const progress = await fixture.snapshot();
  assert.equal(progress.probeRetries, 2);
  assert.equal(progress.corrections, 0);
  assert.deepEqual(
    progress.superseded,
    assignments.slice(0, 2).map((assignment) => assignment.path),
  );
  assert.ok(
    fixture.state.submissions
      .slice(2, 4)
      .every((submission) =>
        submission.text.includes("Probe requires actual native identity"),
      ),
  );
});

await test("exhausted Probe corrections keep the active path available for manual publication", async (t) => {
  const fixture = await implementationRun(t);
  let active: Record<string, unknown> = {};
  fixture.state.onProbe = async (assignment) => {
    active = assignment;
    await publish(String(assignment.path), {
      ...assignment,
      sessionid: assignment.probe_id,
      pr_title: "Title",
      pr_body: "Body",
    });
  };
  fixture.state.onSleep = async (ms) => {
    if (ms === 250)
      await publish(String(active.path), {
        ...active,
        sessionid: "manual-native-session",
        pr_title: "Title",
        pr_body: "Body",
      });
  };
  assert.equal((await fixture.run()).summary.outcome, "incomplete");
  assert.equal(fixture.state.probeCount, 2);
  const progress = await fixture.snapshot();
  assert.equal(progress.probeRetries, 1);
  assert.equal(progress.corrections, 0);
  assert.equal(progress.roles.implement?.sessionid, "manual-native-session");
  assert.equal(progress.probe?.path, active.path);
});

await test("missing Probe output never consumes retries or injects reminders", async (t) => {
  const fixture = await implementationRun(t);
  fixture.state.onProbe = async () => {
    /* Native approval or missing output. */
  };
  let polls = 0;
  fixture.state.onSleep = async (ms) => {
    if (ms === 250 && ++polls === 3) fixture.controller.abort();
  };
  assert.equal((await fixture.run()).summary.outcome, "cancelled");
  assert.equal(fixture.state.probeCount, 1);
  assert.equal(fixture.state.submissions.length, 2);
  assert.equal(fixture.state.taskCount, 0);
  const progress = await fixture.snapshot();
  assert.equal(progress.probeRetries ?? 0, 0);
  assert.equal(progress.corrections, 0);
});

await test("cancelling Probe backoff keeps consumed retry evidence and sends no correction", async (t) => {
  const fixture = await implementationRun(t);
  fixture.state.onProbe = async (assignment) => {
    await publish(String(assignment.path), {
      ...assignment,
      sessionid: assignment.probe_id,
      pr_title: "Title",
      pr_body: "Body",
    });
  };
  fixture.state.onSleep = async (ms) => {
    if (ms === 1_000 || ms === 250) fixture.controller.abort();
  };
  assert.equal((await fixture.run()).summary.outcome, "cancelled");
  assert.equal(fixture.state.probeCount, 1);
  const progress = await fixture.snapshot();
  assert.equal(progress.probeRetries, 1);
  assert.equal(progress.superseded.length, 1);
  assert.ok(await readFile(progress.superseded[0]!, "utf8"));
  assert.notEqual(progress.probe?.path, progress.superseded[0]);
  assert.equal(progress.roles.implement, undefined);
});
