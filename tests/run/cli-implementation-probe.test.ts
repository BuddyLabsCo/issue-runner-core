/* eslint-disable @typescript-eslint/require-await -- Scripted external boundaries. */
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { implementationRun, publish } from "../support/implementation-run.ts";
import { validConfig } from "../support/cli-project.ts";

await test("Probe output contains only discovered identity and metadata", async (t) => {
  const fixture = await implementationRun(t);
  const nativeProbe = fixture.state.onProbe;
  fixture.state.onProbe = async (assignment) => {
    const prompt = fixture.state.submissions.at(-1)!.text;
    assert.doesNotMatch(
      prompt,
      /probe_id|run_id|execution_id|Repository:|Project:|Accepted scope|owner\/repo/u,
    );
    await nativeProbe(assignment);
  };
  assert.equal((await fixture.run()).summary.outcome, "incomplete");
  const saved = await fixture.snapshot();
  const result = JSON.parse(
    await readFile(saved.probe!.path, "utf8"),
  ) as Record<string, unknown>;
  assert.deepEqual(Object.keys(result).sort(), [
    "pr_body",
    "pr_title",
    "sessionid",
  ]);
  assert.deepEqual(Object.keys(saved.probe!), ["path"]);
});

await test("superseded Probe output cannot satisfy the active path", async (t) => {
  const fixture = await implementationRun(t);
  const paths: string[] = [];
  fixture.state.onProbe = async (assignment) => {
    paths.push(String(assignment.path));
    await publish(paths[0]!, {
      sessionid: paths.length === 1 ? "latest" : "actual-native-session",
      pr_title: "Title",
      pr_body: "Body",
    });
  };
  fixture.state.onSleep = async (ms) => {
    if (ms === 250) fixture.controller.abort();
  };
  assert.equal((await fixture.run()).summary.outcome, "cancelled");
  assert.equal(paths.length, 2);
  assert.notEqual(paths[0], paths[1]);
  assert.equal(fixture.state.taskCount, 0);
  assert.equal((await fixture.snapshot()).roles.implement, undefined);
});

await test("invalid Probes use their persisted operation budget and fresh assignments before implementation", async (t) => {
  const fixture = await implementationRun(t, {
    ...validConfig,
    operationRetry: 2,
    agentRetry: 0,
  });
  const assignments: Record<string, unknown>[] = [];
  fixture.state.onProbe = async (assignment) => {
    assert.equal(fixture.state.taskCount, 0);
    assignments.push(assignment);
    const progress = await fixture.snapshot();
    assert.equal(progress.probeRetries ?? 0, assignments.length - 1);
    assert.equal(progress.probe?.path, assignment.path);
    await publish(String(assignment.path), {
      sessionid: assignments.length < 3 ? "latest" : "actual-native-session",
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
  assert.deepEqual(
    fixture.state.sleeps.filter((ms) => ms !== 30_000),
    [10_000, 1_000, 1_000],
  );
  assert.equal(
    new Set(assignments.map((assignment) => assignment.path)).size,
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
      sessionid: "latest",
      pr_title: "Title",
      pr_body: "Body",
    });
  };
  fixture.state.onSleep = async (ms) => {
    if (ms === 250)
      await publish(String(active.path), {
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
