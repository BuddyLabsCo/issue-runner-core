/* eslint-disable @typescript-eslint/require-await -- Scripted external boundaries. */
import { promptAssignment } from "../support/prompt-assignment.ts";
import assert from "node:assert/strict";
import { readdir, writeFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { child, parentRun, parentDeliveryRun } from "../support/parent-run.ts";
import {
  committed,
  publish,
  implementationProgress,
} from "../support/implementation-run.ts";

await test("a withheld initial assignment is submitted in its original conversation when eligibility returns", async (t) => {
  const ticket = child(51);
  const fixture = await parentRun(t, [ticket]);
  const submitted: string[] = [];
  const submitText = fixture.dependencies.terminalPlugin.onInput.bind(
    fixture.dependencies.terminalPlugin,
  );
  fixture.dependencies.terminalPlugin.onInput = async (tab, text) => {
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
  const before = await implementationProgress(fixture.directory, 51);
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
  const after = await implementationProgress(fixture.directory, 51);
  assert.equal(after.phase, "implementation_completed");
  assert.equal(after.execution_id, before.execution_id);
  assert.equal(after.run_id, before.run_id);
  assert.deepEqual(after.invocation, before.invocation);
  assert.deepEqual(after.roles, before.roles);
  assert.equal(after.pr_body, committed(51).pr_body);
  assert.equal(after.pendingPrompt, undefined);
});

await test("a withheld correction retains its prompt, path and native context until eligibility returns", async (t) => {
  const ticket = child(51);
  const fixture = await parentRun(t, [ticket]);
  const submitted: string[] = [];
  const submitText = fixture.dependencies.terminalPlugin.onInput.bind(
    fixture.dependencies.terminalPlugin,
  );
  fixture.dependencies.terminalPlugin.onInput = async (tab, text) => {
    submitted.push(text);
    if (text === "continue") {
      fixture.controller.abort();
      return;
    }
    if (text.startsWith("Correct the implementation handoff:")) {
      const assignment = promptAssignment(text);
      await publish(assignment.path, committed(51));
      return;
    }
    await submitText(tab, text);
    if (text.startsWith("Implementation assignment\n")) {
      const invocation = promptAssignment(text) as { path: string };
      await publish(invocation.path, {});
      ticket.labels = ["sandcastle:reserved"];
    }
  };
  fixture.dependencies.clock.sleep = async (ms) => {
    assert.equal(ms === 10_000 || ms === 1000 || ms === 30_000, true);
  };
  assert.equal((await fixture.run()).summary.outcome, "incomplete");
  const before = await implementationProgress(fixture.directory, 51);
  assert.equal(before.superseded.length, 1);
  assert.match(before.pendingPrompt!, /^Correct the implementation handoff:/u);
  const resumedAt = submitted.length;
  ticket.labels!.push("ready-for-agent");
  const result = await fixture.run();
  assert.equal(result.summary.outcome, "incomplete", JSON.stringify(result));
  const resumed = submitted.slice(resumedAt);
  assert.equal(resumed[0], 'any-cli --resume "native-51"');
  assert.match(resumed[1]!, /^Correct the implementation handoff:/u);
  assert.equal(resumed.length, 2);
  assert.equal(resumed[1], before.pendingPrompt);
  assert.ok(resumed[1]!.includes(JSON.stringify(before.invocation!.path)));
  assert.deepEqual(fixture.dispatched, [51]);
  const after = await implementationProgress(fixture.directory, 51);
  assert.equal(after.phase, "implementation_completed");
  assert.equal(after.execution_id, before.execution_id);
  assert.equal(after.run_id, before.run_id);
  assert.deepEqual(after.invocation, before.invocation);
  assert.deepEqual(after.roles, before.roles);
  assert.equal(after.pr_body, committed(51).pr_body);
  assert.deepEqual(after.superseded, before.superseded);
  assert.equal(after.pendingPrompt, undefined);
});

await test("cancellation inside the dispatch gate retains the known unsent assignment for recovery", async (t) => {
  const fixture = await parentRun(t, [child(51)]);
  let cancelAtGate = false;
  const submitText = fixture.dependencies.terminalPlugin.onInput.bind(
    fixture.dependencies.terminalPlugin,
  );
  fixture.dependencies.terminalPlugin.onInput = async (tab, text) => {
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
  const before = await implementationProgress(fixture.directory, 51);
  assert.match(before.pendingPrompt!, /^Implementation assignment\n/u);
  assert.deepEqual(fixture.dispatched, []);
  fixture.dependencies.signal = new AbortController().signal;
  assert.equal((await fixture.run()).summary.outcome, "incomplete");
  assert.deepEqual(fixture.dispatched, [51]);
  assert.deepEqual(
    (await implementationProgress(fixture.directory, 51)).invocation,
    before.invocation,
  );
});

await test("valid output at a pending assignment completes without reopening its conversation", async (t) => {
  const ticket = child(51);
  const fixture = await parentDeliveryRun(t, [ticket]);
  const submitText = fixture.dependencies.terminalPlugin.onInput.bind(
    fixture.dependencies.terminalPlugin,
  );
  fixture.dependencies.terminalPlugin.onInput = async (tab, text) => {
    await submitText(tab, text);
    if (text.startsWith("Session Probe\n"))
      ticket.labels = ["sandcastle:reserved"];
  };
  assert.equal((await fixture.run()).summary.outcome, "incomplete");
  const before = await implementationProgress(fixture.directory, 51);
  await publish(before.invocation!.path, {
    outcome: "no_change",
    pr_title: "docs: maintain documentation",
    pr_body: "Maintain documentation.",
    summary: "No changes needed.",
    commits: [],
    findings_file: null,
  });
  fixture.dependencies.tracker.commentTicket = async () => {
    /* Scripted successful comment. */
  };
  ticket.labels!.push("ready-for-agent");
  fixture.dependencies.terminalPlugin.createTab = async () => {
    assert.fail("valid retained output does not need another prompt");
  };
  assert.equal((await fixture.run()).summary.outcome, "succeeded");
  const after = await implementationProgress(fixture.directory, 51);
  assert.equal(after.phase, "implementation_completed");
  assert.equal(after.pendingPrompt, undefined);
  assert.deepEqual(after.invocation, before.invocation);
  assert.deepEqual(fixture.dispatched, []);
});

await test("a transport attempt is not replayed as a known unsent assignment after interruption", async (t) => {
  const fixture = await parentDeliveryRun(t, [child(51)]);
  fixture.dependencies.tracker.commentTicket = async () => {
    /* Scripted successful comment. */
  };
  const submitted: string[] = [];
  const submitText = fixture.dependencies.terminalPlugin.onInput.bind(
    fixture.dependencies.terminalPlugin,
  );
  fixture.dependencies.terminalPlugin.onInput = async (tab, text) => {
    submitted.push(text);
    if (text.startsWith("Implementation assignment\n")) {
      assert.equal(
        (await implementationProgress(fixture.directory, 51)).pendingPrompt,
        undefined,
      );
      throw new Error("transport acknowledgement lost");
    }
    if (text === "continue") {
      const current = await implementationProgress(fixture.directory, 51);
      await publish(current.invocation!.path, {
        outcome: "no_change",
        pr_title: "docs: maintain documentation",
        pr_body: "Maintain documentation.",
        summary: "No changes needed.",
        commits: [],
        findings_file: null,
      });
      return;
    }
    await submitText(tab, text);
  };
  assert.equal((await fixture.run()).summary.outcome, "failed");
  const before = await implementationProgress(fixture.directory, 51);
  assert.equal(before.pendingPrompt, undefined);
  const resumedAt = submitted.length;
  assert.equal((await fixture.run()).summary.outcome, "succeeded");
  assert.deepEqual(submitted.slice(resumedAt), [
    'any-cli --resume "native-51"',
    "continue",
  ]);
  assert.deepEqual(
    (await implementationProgress(fixture.directory, 51)).invocation,
    before.invocation,
  );
});

await test("malformed pending prompt evidence fails recovery before another Agent submission", async (t) => {
  const ticket = child(51);
  const fixture = await parentRun(t, [ticket]);
  const submitText = fixture.dependencies.terminalPlugin.onInput.bind(
    fixture.dependencies.terminalPlugin,
  );
  fixture.dependencies.terminalPlugin.onInput = async (tab, text) => {
    await submitText(tab, text);
    if (text.startsWith("Session Probe\n"))
      ticket.labels = ["sandcastle:reserved"];
  };
  await fixture.run();
  const before = await implementationProgress(fixture.directory, 51);
  const recovery = path.join(fixture.directory, "recovery");
  const [file] = (await readdir(recovery)).filter((file) =>
    file.endsWith("-51.json"),
  );
  await writeFile(
    path.join(recovery, file!),
    JSON.stringify({ ...before, pendingPrompt: 17 }),
  );
  ticket.labels!.push("ready-for-agent");
  fixture.dependencies.terminalPlugin.createTab = async () => {
    assert.fail("invalid checkpoint cannot authorize a submission");
  };
  fixture.dependencies.operator.pause = async (message) => {
    assert.equal(
      message,
      "Enter to restart the entire Issue #51, or q to exit Runner.",
    );
    return "q";
  };
  const result = await fixture.run();
  assert.equal(result.summary.outcome, "cancelled");
  assert.ok(fixture.dependencies.messages.includes("unable to recover"));
  assert.deepEqual(fixture.dispatched, []);
});
