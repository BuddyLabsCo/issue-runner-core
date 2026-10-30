/* eslint-disable @typescript-eslint/require-await -- Scripted external boundaries. */
import assert from "node:assert/strict";
import test from "node:test";
import { child, parentRun } from "../support/parent-run.ts";
import { publish } from "../support/implementation-run.ts";

await test("parent cancellation during Git setup prevents substantive Agent dispatch", async (t) => {
  const fixture = await parentRun(t, [child(51)]);
  let cancelled = false;
  fixture.dependencies.tracker.getParent = async () => ({
    number: 48,
    state: cancelled ? "closed" : "open",
    stateReason: cancelled ? "not_planned" : null,
  });
  fixture.dependencies.gitWorkspace.fetchTargetBranch = async () => {
    cancelled = true;
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
  "reservation_label",
  "runner",
  "closed",
] as const) {
  await test(`eligibility becoming ${change} during the Probe prevents implementation dispatch`, async (t) => {
    const ticket = child(51);
    const fixture = await parentRun(t, [ticket]);
    let changed = false;
    fixture.dependencies.tracker.getParent = async () => ({
      number: 48,
      state: changed && change === "cancelled" ? "closed" : "open",
      stateReason: changed && change === "cancelled" ? "not_planned" : null,
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
    const submitText = fixture.dependencies.terminalPlugin.submitText.bind(
      fixture.dependencies.terminalPlugin,
    );
    fixture.dependencies.terminalPlugin.submitText = async (tab, text) => {
      await submitText(tab, text);
      if (!text.startsWith("Session Probe\n")) return;
      changed = true;
      if (change === "external") ticket.assignees!.push("developer");
      if (change === "not_ready") ticket.labels = ["sandcastle:reserved"];
      if (change === "reservation_label") ticket.labels = ["ready-for-agent"];
      if (change === "runner") ticket.assignees = [];
      if (change === "closed") {
        ticket.state = "closed";
        ticket.stateReason = "completed";
      }
    };
    const result = await fixture.run();
    assert.equal(
      result.summary.outcome,
      change === "cancelled" ? "cancelled" : "incomplete",
    );
    assert.deepEqual(fixture.dispatched, []);
    assert.deepEqual(fixture.writes, ["label:51", "assignee:51"]);
    assert.match(
      result.summary.reasons.join("; "),
      /cancelled|scope|owned|blocked|ready-for-agent|Reservation|terminal/u,
    );
  });
}

await test("parent cancellation during native startup prevents implementation dispatch", async (t) => {
  const fixture = await parentRun(t, [child(51)]);
  let cancelled = false;
  fixture.dependencies.clock.sleep = async (ms) => {
    if (ms === 10_000) cancelled = true;
  };
  fixture.dependencies.tracker.getParent = async () => ({
    number: 48,
    state: cancelled ? "closed" : "open",
    stateReason: cancelled ? "not_planned" : null,
  });
  assert.equal((await fixture.run()).summary.outcome, "cancelled");
  assert.deepEqual(fixture.dispatched, []);
});

for (const operation of ["addLabel", "addAssignee"] as const) {
  for (const change of [
    "cancelled",
    "external",
    "blocked",
    "left_scope",
    "not_ready",
    "reservation",
  ] as const) {
    await test(`${operation} retry stops when eligibility becomes ${change} during backoff`, async (t) => {
      const ticket = child(51);
      const fixture = await parentRun(t, [ticket]);
      let changed = false;
      let attempts = 0;
      fixture.dependencies.tracker.getParent = async () => ({
        number: 48,
        state: changed && change === "cancelled" ? "closed" : "open",
        stateReason: changed && change === "cancelled" ? "not_planned" : null,
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
        if (change === "external") ticket.assignees!.push("developer");
        if (change === "not_ready") ticket.labels = [];
        if (change === "reservation") {
          if (operation === "addLabel") ticket.assignees = ["runner"];
          else ticket.labels = ["ready-for-agent"];
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

await test("a lost assignee response reconciles the complete Reservation without repeating the write", async (t) => {
  const fixture = await parentRun(t, [child(51)]);
  const addAssignee = fixture.dependencies.tracker.addAssignee.bind(
    fixture.dependencies.tracker,
  );
  fixture.dependencies.tracker.addAssignee = async (...args) => {
    await addAssignee(...args);
    throw new Error("response lost after assignment");
  };
  assert.equal((await fixture.run()).summary.outcome, "incomplete");
  assert.deepEqual(fixture.dispatched, [51]);
  assert.deepEqual(fixture.writes, ["label:51", "assignee:51"]);
});

await test("parent cancellation during correction backoff prevents the follow-up prompt", async (t) => {
  const fixture = await parentRun(t, [child(51)]);
  let cancelled = false;
  const followups: string[] = [];
  fixture.dependencies.tracker.getParent = async () => ({
    number: 48,
    state: cancelled ? "closed" : "open",
    stateReason: cancelled ? "not_planned" : null,
  });
  fixture.dependencies.clock.sleep = async (ms) => {
    if (ms === 2000) cancelled = true;
  };
  const submitText = fixture.dependencies.terminalPlugin.submitText.bind(
    fixture.dependencies.terminalPlugin,
  );
  fixture.dependencies.terminalPlugin.submitText = async (tab, text) => {
    if (text.startsWith("Correct the implementation handoff:")) {
      followups.push(text);
      fixture.controller.abort();
      return;
    }
    await submitText(tab, text);
    if (text.startsWith("Implementation assignment\n")) {
      const assignment = JSON.parse(text.split("\n")[1]!) as { path: string };
      await publish(assignment.path, { outcome: "invalid" });
    }
  };
  assert.equal((await fixture.run()).summary.outcome, "cancelled");
  assert.deepEqual(fixture.dispatched, [51]);
  assert.deepEqual(followups, []);
});

await test("parent cancellation during recovery startup prevents continue in the retained conversation", async (t) => {
  const fixture = await parentRun(t, [child(51)]);
  let controller = fixture.controller;
  const followups: string[] = [];
  const submitText = fixture.dependencies.terminalPlugin.submitText.bind(
    fixture.dependencies.terminalPlugin,
  );
  fixture.dependencies.terminalPlugin.submitText = async (tab, text) => {
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
  let cancelled = false;
  fixture.dependencies.clock.sleep = async (ms) => {
    if (ms === 10_000) cancelled = true;
  };
  fixture.dependencies.tracker.getParent = async () => ({
    number: 48,
    state: cancelled ? "closed" : "open",
    stateReason: cancelled ? "not_planned" : null,
  });
  assert.equal((await fixture.run()).summary.outcome, "cancelled");
  assert.deepEqual(fixture.dispatched, []);
  assert.deepEqual(followups, []);
  assert.deepEqual(fixture.writes, ["label:51", "assignee:51"]);
});
