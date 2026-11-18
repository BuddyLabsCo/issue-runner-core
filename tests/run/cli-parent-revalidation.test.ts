/* eslint-disable @typescript-eslint/require-await -- Scripted external boundaries. */
import { promptAssignment } from "../support/prompt-assignment.ts";
import assert from "node:assert/strict";
import test from "node:test";
import { child, parentDeliveryRun, parentRun } from "../support/parent-run.ts";
import { publish } from "../support/implementation-run.ts";

await test("run cancellation during Git setup prevents substantive Agent dispatch", async (t) => {
  const fixture = await parentRun(t, [child(51)]);
  fixture.dependencies.gitWorkspace.fetchTargetBranch = async () => {
    fixture.controller.abort();
    return "a".repeat(40);
  };
  const result = await fixture.run();
  assert.equal(result.summary.outcome, "cancelled");
  assert.deepEqual(fixture.dispatched, []);
  assert.deepEqual(fixture.writes, ["label:51", "assignee:51"]);
});

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

for (const change of [
  "cancelled",
  "left_scope",
  "external",
  "blocked",
  "not_ready",
  "closed",
] as const) {
  await test(`Issue start checks fresh eligibility when discovery missed ${change}`, async (t) => {
    const ticket = child(51);
    const fixture = await parentDeliveryRun(t, [ticket]);
    let changed = false;
    fixture.dependencies.tracker.getParent = async () => ({
      number: 48,
      state:
        changed && change === "cancelled" ? "closed" : fixture.parent.state,
      stateReason:
        changed && change === "cancelled"
          ? "not_planned"
          : fixture.parent.stateReason,
    });
    fixture.dependencies.tracker.listChildrenPage = async () => ({
      children:
        changed && change === "left_scope" ? [] : [structuredClone(ticket)],
      nextPage: null,
    });
    fixture.dependencies.tracker.listBlockersPage = async () => ({
      blockers: changed && change === "blocked" ? [child(900)] : [],
      nextPage: null,
    });
    const { tracker } = fixture.dependencies;
    const start = tracker.readIssueStart.bind(tracker);
    tracker.readIssueStart = async (...args) => {
      changed = true;
      if (change === "external") ticket.assignees!.push("developer");
      if (change === "not_ready") ticket.labels = ["sandcastle:reserved"];
      if (change === "closed") {
        ticket.state = "closed";
        ticket.stateReason = "completed";
      }
      return start(...args);
    };
    const result = await fixture.run();
    assert.equal(
      result.summary.outcome,
      change === "cancelled"
        ? "cancelled"
        : change === "closed" || change === "left_scope"
          ? "succeeded"
          : "incomplete",
    );
    assert.deepEqual(fixture.dispatched, []);
    assert.deepEqual(fixture.writes, []);
    assert.match(
      result.summary.tickets![0]!.detail,
      /cancelled|scope|owned|blocked|ready-for-agent|Reservation|terminal/u,
    );
  });
}

await test("run cancellation during native startup prevents implementation dispatch", async (t) => {
  const fixture = await parentRun(t, [child(51)]);
  const start = fixture.dependencies.terminalPlugin.execute.bind(
    fixture.dependencies.terminalPlugin,
  );
  fixture.dependencies.terminalPlugin.execute = async (tab, command) => {
    await start(tab, command);
    fixture.controller.abort();
    return undefined;
  };
  assert.equal((await fixture.run()).summary.outcome, "cancelled");
  assert.deepEqual(fixture.dispatched, []);
});

for (const change of ["cancelled", "external", "left_scope"] as const) {
  await test(`a start retry stops when the Parent or Issue becomes ${change} during backoff`, async (t) => {
    const ticket = child(51);
    const fixture = await parentDeliveryRun(t, [ticket]);
    const { tracker, clock } = fixture.dependencies;
    let attempts = 0;
    tracker.reserveIssue = async () => {
      attempts += 1;
      throw new Error("request failed before writing");
    };
    const list = tracker.listChildrenPage.bind(tracker);
    clock.sleep = async (ms) => {
      assert.equal(ms, 1000);
      if (change === "cancelled") {
        fixture.parent.state = "closed";
        fixture.parent.stateReason = "not_planned";
      } else if (change === "external") {
        ticket.assignees = ["developer"];
      } else {
        tracker.listChildrenPage = async (...args) => ({
          ...(await list(...args)),
          children: [],
        });
      }
    };
    const result = await fixture.run();
    assert.equal(
      result.summary.outcome,
      change === "cancelled"
        ? "cancelled"
        : change === "left_scope"
          ? "succeeded"
          : "incomplete",
    );
    assert.equal(attempts, 1);
    assert.deepEqual(fixture.dispatched, []);
    assert.deepEqual(fixture.writes, []);
  });
}

await test("run cancellation after an invalid handoff prevents the follow-up prompt", async (t) => {
  const fixture = await parentRun(t, [child(51)]);
  const followups: string[] = [];
  const submitText = fixture.dependencies.terminalPlugin.onInput.bind(
    fixture.dependencies.terminalPlugin,
  );
  fixture.dependencies.terminalPlugin.onInput = async (tab, text) => {
    if (text.startsWith("Correct the implementation handoff:")) {
      followups.push(text);
      fixture.controller.abort();
      return;
    }
    await submitText(tab, text);
    if (text.startsWith("Implementation assignment\n")) {
      const assignment = promptAssignment(text) as { path: string };
      await publish(assignment.path, { outcome: "invalid" });
      fixture.controller.abort();
    }
  };
  assert.equal((await fixture.run()).summary.outcome, "cancelled");
  assert.deepEqual(fixture.dispatched, [51]);
  assert.deepEqual(followups, []);
});

await test("run cancellation during recovery startup prevents continue in the retained conversation", async (t) => {
  const fixture = await parentRun(t, [child(51)]);
  let controller = fixture.controller;
  const followups: string[] = [];
  const submitText = fixture.dependencies.terminalPlugin.onInput.bind(
    fixture.dependencies.terminalPlugin,
  );
  fixture.dependencies.terminalPlugin.onInput = async (tab, text) => {
    if (text.startsWith("Implementation assignment\n") || text === "continue") {
      followups.push(text);
      controller.abort();
      return;
    }
    await submitText(tab, text);
  };
  assert.equal((await fixture.run()).summary.outcome, "cancelled");
  followups.length = 0;
  controller = new AbortController();
  fixture.dependencies.signal = controller.signal;
  const resume = fixture.dependencies.terminalPlugin.execute.bind(
    fixture.dependencies.terminalPlugin,
  );
  fixture.dependencies.terminalPlugin.execute = async (tab, command) => {
    await resume(tab, command);
    controller.abort();
  };
  assert.equal((await fixture.run()).summary.outcome, "cancelled");
  assert.deepEqual(fixture.dispatched, []);
  assert.deepEqual(followups, []);
  assert.deepEqual(fixture.writes, ["label:51", "assignee:51"]);
});
