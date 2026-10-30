/* eslint-disable @typescript-eslint/require-await -- Scripted external boundaries. */
import assert from "node:assert/strict";
import { readFile, readdir, writeFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import type { ImplementationProgress } from "../../src/recovery.ts";
import { child, parentRun } from "../support/parent-run.ts";
import { validConfig } from "../support/cli-project.ts";
import { committed, publish } from "../support/implementation-run.ts";

async function snapshot(directory: string): Promise<ImplementationProgress> {
  const recovery = path.join(directory, "recovery");
  const files = await readdir(recovery);
  assert.equal(files.length, 1);
  return JSON.parse(
    await readFile(path.join(recovery, files[0]!), "utf8"),
  ) as ImplementationProgress;
}

await test("a withheld initial assignment is submitted in its original conversation when eligibility returns", async (t) => {
  const ticket = child(51);
  const fixture = await parentRun(t, [ticket]);
  const submitted: string[] = [];
  const submitText = fixture.dependencies.terminalPlugin.submitText.bind(
    fixture.dependencies.terminalPlugin,
  );
  fixture.dependencies.terminalPlugin.submitText = async (tab, text) => {
    submitted.push(text);
    if (text === "continue") {
      fixture.controller.abort();
      return;
    }
    await submitText(tab, text);
    if (text.startsWith("Session Probe\n"))
      ticket.labels = ["sandcastle:reserved"];
  };
  assert.equal((await fixture.run()).summary.outcome, "incomplete");
  assert.deepEqual(fixture.dispatched, []);
  const before = await snapshot(fixture.directory);
  assert.match(before.pendingPrompt!, /^Implementation assignment\n/u);
  const resumedAt = submitted.length;
  ticket.labels!.push("ready-for-agent");
  const result = await fixture.run();
  assert.equal(result.summary.outcome, "incomplete");
  const resumed = submitted.slice(resumedAt);
  assert.equal(resumed[0], 'any-cli --resume "native-51"');
  assert.match(resumed[1]!, /^Implementation assignment\n/u);
  assert.equal(resumed.length, 2);
  assert.equal(resumed[1], before.pendingPrompt);
  assert.ok(resumed[1]!.includes(JSON.stringify(before.invocation!.path)));
  assert.deepEqual(fixture.dispatched, [51]);
  assert.deepEqual(fixture.writes, ["label:51", "assignee:51"]);
  const after = await snapshot(fixture.directory);
  assert.equal(after.phase, "implementation_completed");
  assert.equal(after.execution_id, before.execution_id);
  assert.equal(after.run_id, before.run_id);
  assert.deepEqual(after.invocation, before.invocation);
  assert.deepEqual(after.roles, before.roles);
  assert.equal(after.pr_body, before.pr_body);
  assert.equal(after.corrections, 0);
  assert.equal(after.pendingPrompt, undefined);
});

await test("a withheld correction retains its prompt, path and spent budget until eligibility returns", async (t) => {
  const ticket = child(51);
  const fixture = await parentRun(t, [ticket], {
    ...validConfig,
    agentRetry: 1,
  });
  const submitted: string[] = [];
  const submitText = fixture.dependencies.terminalPlugin.submitText.bind(
    fixture.dependencies.terminalPlugin,
  );
  fixture.dependencies.terminalPlugin.submitText = async (tab, text) => {
    submitted.push(text);
    if (text === "continue") {
      fixture.controller.abort();
      return;
    }
    if (text.startsWith("Correct the implementation handoff:")) {
      const file = JSON.parse(
        text.slice(text.lastIndexOf("argument: ") + 10),
      ) as string;
      await publish(file, committed());
      return;
    }
    await submitText(tab, text);
    if (text.startsWith("Implementation assignment\n")) {
      const invocation = JSON.parse(text.split("\n")[1]!) as { path: string };
      await publish(invocation.path, {});
    }
  };
  fixture.dependencies.clock.sleep = async (ms) => {
    assert.equal(ms === 10_000 || ms === 2000, true);
    if (ms === 2000) ticket.labels = ["sandcastle:reserved"];
  };
  assert.equal((await fixture.run()).summary.outcome, "incomplete");
  const before = await snapshot(fixture.directory);
  assert.equal(before.corrections, 1);
  assert.equal(before.superseded.length, 1);
  assert.match(before.pendingPrompt!, /^Correct the implementation handoff:/u);
  const resumedAt = submitted.length;
  ticket.labels!.push("ready-for-agent");
  assert.equal((await fixture.run()).summary.outcome, "incomplete");
  const resumed = submitted.slice(resumedAt);
  assert.equal(resumed[0], 'any-cli --resume "native-51"');
  assert.match(resumed[1]!, /^Correct the implementation handoff:/u);
  assert.equal(resumed.length, 2);
  assert.equal(resumed[1], before.pendingPrompt);
  assert.ok(resumed[1]!.includes(JSON.stringify(before.invocation!.path)));
  assert.deepEqual(fixture.dispatched, [51]);
  const after = await snapshot(fixture.directory);
  assert.equal(after.phase, "implementation_completed");
  assert.equal(after.execution_id, before.execution_id);
  assert.equal(after.run_id, before.run_id);
  assert.deepEqual(after.invocation, before.invocation);
  assert.deepEqual(after.roles, before.roles);
  assert.equal(after.pr_body, before.pr_body);
  assert.equal(after.corrections, before.corrections);
  assert.deepEqual(after.superseded, before.superseded);
  assert.equal(after.pendingPrompt, undefined);
});

await test("cancellation inside the dispatch gate retains the known unsent assignment for recovery", async (t) => {
  const fixture = await parentRun(t, [child(51)]);
  let cancelAtGate = false;
  const submitText = fixture.dependencies.terminalPlugin.submitText.bind(
    fixture.dependencies.terminalPlugin,
  );
  fixture.dependencies.terminalPlugin.submitText = async (tab, text) => {
    if (text === "continue") {
      assert.fail("the withheld assignment has not been submitted");
    }
    await submitText(tab, text);
    if (text.startsWith("Session Probe\n")) cancelAtGate = true;
  };
  fixture.dependencies.tracker.getParent = async () => {
    if (cancelAtGate) {
      cancelAtGate = false;
      fixture.controller.abort();
    }
    return { number: 48, state: "open", stateReason: null };
  };
  assert.equal((await fixture.run()).summary.outcome, "cancelled");
  const before = await snapshot(fixture.directory);
  assert.match(before.pendingPrompt!, /^Implementation assignment\n/u);
  assert.deepEqual(fixture.dispatched, []);
  fixture.dependencies.signal = new AbortController().signal;
  assert.equal((await fixture.run()).summary.outcome, "incomplete");
  assert.deepEqual(fixture.dispatched, [51]);
  assert.deepEqual(
    (await snapshot(fixture.directory)).invocation,
    before.invocation,
  );
});

await test("valid output at a pending assignment completes without reopening its conversation", async (t) => {
  const ticket = child(51);
  const fixture = await parentRun(t, [ticket]);
  const submitText = fixture.dependencies.terminalPlugin.submitText.bind(
    fixture.dependencies.terminalPlugin,
  );
  fixture.dependencies.terminalPlugin.submitText = async (tab, text) => {
    await submitText(tab, text);
    if (text.startsWith("Session Probe\n"))
      ticket.labels = ["sandcastle:reserved"];
  };
  assert.equal((await fixture.run()).summary.outcome, "incomplete");
  const before = await snapshot(fixture.directory);
  await publish(before.invocation!.path, {
    outcome: "no_change",
    summary: "No changes needed.",
    commits: [],
    findings_file: null,
  });
  ticket.labels!.push("ready-for-agent");
  fixture.dependencies.terminalPlugin.createTab = async () => {
    assert.fail("valid retained output does not need another prompt");
  };
  assert.equal((await fixture.run()).summary.outcome, "incomplete");
  const after = await snapshot(fixture.directory);
  assert.equal(after.phase, "implementation_completed");
  assert.equal(after.pendingPrompt, undefined);
  assert.deepEqual(after.invocation, before.invocation);
  assert.deepEqual(fixture.dispatched, []);
});

await test("a transport attempt is not replayed as a known unsent assignment after interruption", async (t) => {
  const fixture = await parentRun(t, [child(51)]);
  const submitted: string[] = [];
  const submitText = fixture.dependencies.terminalPlugin.submitText.bind(
    fixture.dependencies.terminalPlugin,
  );
  fixture.dependencies.terminalPlugin.submitText = async (tab, text) => {
    submitted.push(text);
    if (text.startsWith("Implementation assignment\n")) {
      assert.equal(
        (await snapshot(fixture.directory)).pendingPrompt,
        undefined,
      );
      throw new Error("transport acknowledgement lost");
    }
    if (text === "continue") {
      const current = await snapshot(fixture.directory);
      await publish(current.invocation!.path, {
        outcome: "no_change",
        summary: "No changes needed.",
        commits: [],
        findings_file: null,
      });
      return;
    }
    await submitText(tab, text);
  };
  assert.equal((await fixture.run()).summary.outcome, "failed");
  const before = await snapshot(fixture.directory);
  assert.equal(before.pendingPrompt, undefined);
  const resumedAt = submitted.length;
  assert.equal((await fixture.run()).summary.outcome, "incomplete");
  assert.deepEqual(submitted.slice(resumedAt), [
    'any-cli --resume "native-51"',
    "continue",
  ]);
  assert.deepEqual(
    (await snapshot(fixture.directory)).invocation,
    before.invocation,
  );
});

await test("malformed pending prompt evidence fails recovery before another Agent submission", async (t) => {
  const ticket = child(51);
  const fixture = await parentRun(t, [ticket]);
  const submitText = fixture.dependencies.terminalPlugin.submitText.bind(
    fixture.dependencies.terminalPlugin,
  );
  fixture.dependencies.terminalPlugin.submitText = async (tab, text) => {
    await submitText(tab, text);
    if (text.startsWith("Session Probe\n"))
      ticket.labels = ["sandcastle:reserved"];
  };
  await fixture.run();
  const before = await snapshot(fixture.directory);
  const recovery = path.join(fixture.directory, "recovery");
  const [file] = await readdir(recovery);
  await writeFile(
    path.join(recovery, file!),
    JSON.stringify({ ...before, pendingPrompt: 17 }),
  );
  ticket.labels!.push("ready-for-agent");
  fixture.dependencies.terminalPlugin.createTab = async () => {
    assert.fail("invalid checkpoint cannot authorize a submission");
  };
  const result = await fixture.run();
  assert.equal(result.summary.outcome, "failed");
  assert.match(result.summary.reasons.join("; "), /unable to recover/u);
  assert.deepEqual(fixture.dispatched, []);
});
