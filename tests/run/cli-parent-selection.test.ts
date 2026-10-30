/* eslint-disable @typescript-eslint/require-await -- Scripted external boundaries. */
import assert from "node:assert/strict";
import { readFile, readdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { stringify } from "yaml";
import test from "node:test";
import { validConfig } from "../support/cli-project.ts";
import { child, parentRun } from "../support/parent-run.ts";

await test("parent dispatches the lowest eligible direct children up to the configured Batch size", async (t) => {
  const fixture = await parentRun(
    t,
    [child(54), child(51), child(53), child(52)],
    {
      ...validConfig,
      maxBatchSize: 2,
    },
  );
  const result = await fixture.run();
  assert.deepEqual(
    [...fixture.dispatched].sort((a, b) => a - b),
    [51, 52],
  );
  assert.deepEqual(
    [...fixture.writes].sort(),
    ["label:51", "assignee:51", "label:52", "assignee:52"].sort(),
  );
  assert.equal(result.summary.outcome, "incomplete");
  assert.match(
    result.summary.reasons.join(" "),
    /selected Delivery Tickets: 51, 52/u,
  );
});

await test("parent reads every child and blocker page before selecting across labels, ownership and Issue List filtering", async (t) => {
  const children = [
    child(51),
    child(52, { assignees: ["developer"] }),
    child(53, { labels: ["ready-for-agent", "sandcastle:reserved"] }),
    child(54, { assignees: ["runner"] }),
    child(55, {
      assignees: ["runner"],
      labels: ["ready-for-agent", "sandcastle:reserved"],
    }),
    child(56, { labels: ["Ready-For-Agent"] }),
    child(57, { labels: ["ready-for-agent", "backlog"] }),
    child(58),
    child(59, { state: "closed", stateReason: "not_planned" }),
    child(60),
  ];
  const fixture = await parentRun(t, children, {
    ...validConfig,
    issueList: [51, 52, 53, 54, 55, 56, 57, 59, 60, 999],
  });
  const childPages: number[] = [];
  const blockerPages: string[] = [];
  fixture.dependencies.tracker.listChildrenPage = async (
    _repo,
    _parent,
    page,
  ) => {
    childPages.push(page);
    return {
      children: structuredClone(
        page === 1 ? children.slice(5) : page === 2 ? [] : children.slice(0, 5),
      ),
      nextPage: page < 3 ? page + 1 : null,
    };
  };
  fixture.dependencies.tracker.listBlockersPage = async (
    _repo,
    number,
    page,
  ) => {
    blockerPages.push(`${number}:${page}`);
    assert.equal(
      fixture.writes.length,
      0,
      "complete discovery precedes Reservations",
    );
    if (number === 51)
      return {
        blockers: [
          child(900 + page, {
            repository: "outside/repo",
            ...(page === 2
              ? {}
              : { state: "closed", stateReason: "completed" }),
          }),
        ],
        nextPage: page < 3 ? page + 1 : null,
      };
    if (number === 60)
      return {
        blockers: [
          child(910 + page, {
            state: "closed",
            stateReason: page === 1 ? "completed" : "not_planned",
          }),
        ],
        nextPage: page === 1 ? 2 : null,
      };
    return { blockers: [], nextPage: null };
  };
  // Revalidation reads may happen after Reservation writes.
  const discoveryBlockers = fixture.dependencies.tracker.listBlockersPage.bind(
    fixture.dependencies.tracker,
  );
  fixture.dependencies.tracker.listBlockersPage = async (...args) => {
    if (fixture.writes.length) return { blockers: [], nextPage: null };
    return discoveryBlockers(...args);
  };
  const result = await fixture.run();
  assert.deepEqual(
    [...fixture.dispatched].sort((a, b) => a - b),
    [57, 60],
  );
  assert.deepEqual(
    [...fixture.writes].sort(),
    ["label:57", "assignee:57", "label:60", "assignee:60"].sort(),
  );
  assert.deepEqual(childPages.slice(0, 3), [1, 2, 3]);
  assert.deepEqual(blockerPages.slice(0, 13), [
    "51:1",
    "51:2",
    "51:3",
    "52:1",
    "53:1",
    "54:1",
    "55:1",
    "56:1",
    "57:1",
    "58:1",
    "59:1",
    "60:1",
    "60:2",
  ]);
  assert.match(
    result.summary.reasons.join("; "),
    /blocked Delivery Tickets: 51/u,
  );
  assert.match(
    result.summary.reasons.join("; "),
    /externally owned Delivery Tickets: 52/u,
  );
  assert.match(
    result.summary.reasons.join("; "),
    /existing Reservations: 53 \(partial\), 54 \(partial\), 55 \(complete\)/u,
  );
  assert.match(
    result.summary.reasons.join("; "),
    /configured Delivery Tickets not found: 999/u,
  );
});

await test("parent cancellation after a partial Reservation prevents assignment and dispatch", async (t) => {
  const fixture = await parentRun(t, [child(51)]);
  fixture.dependencies.tracker.getParent = async () => ({
    number: 48,
    state: fixture.writes.length ? "closed" : "open",
    stateReason: fixture.writes.length ? "not_planned" : null,
  });
  const result = await fixture.run();
  assert.equal(result.summary.outcome, "cancelled");
  assert.deepEqual(fixture.writes, ["label:51"]);
  assert.deepEqual(fixture.dispatched, []);
});

await test("a lost Reservation label prevents creating a partial assignee Reservation", async (t) => {
  const ticket = child(51);
  const fixture = await parentRun(t, [ticket]);
  const addLabel = fixture.dependencies.tracker.addLabel.bind(
    fixture.dependencies.tracker,
  );
  fixture.dependencies.tracker.addLabel = async (...args) => {
    await addLabel(...args);
    ticket.labels = ["ready-for-agent"];
  };
  const result = await fixture.run();
  assert.equal(result.summary.outcome, "incomplete");
  assert.deepEqual(fixture.writes, ["label:51"]);
  assert.deepEqual(fixture.dispatched, []);
  assert.match(result.summary.reasons.join("; "), /Reservation changed/u);
});

await test("matching parent progress continues only recorded Reservations among unrelated residual markers", async (t) => {
  const children = [child(55), child(56)];
  const fixture = await parentRun(t, children, {
    ...validConfig,
    maxBatchSize: 2,
  });
  await fixture.run();
  const checkpoints = await readdir(path.join(fixture.directory, "recovery"));
  const original = await Promise.all(
    checkpoints.map((file) =>
      readFile(path.join(fixture.directory, "recovery", file), "utf8"),
    ),
  );
  children.push(
    child(51, {
      labels: ["ready-for-agent", "sandcastle:reserved"],
      assignees: ["runner"],
    }),
    child(52, { labels: ["ready-for-agent", "sandcastle:reserved"] }),
    child(53, { assignees: ["runner"] }),
    child(54, {
      assignees: ["developer", "runner"],
      labels: ["ready-for-agent", "sandcastle:reserved"],
    }),
  );
  const result = await fixture.run();
  assert.equal(result.summary.outcome, "incomplete");
  assert.match(
    result.summary.reasons.join("; "),
    /selected Delivery Tickets: 55, 56/u,
  );
  assert.deepEqual(
    [...fixture.dispatched].sort((a, b) => a - b),
    [55, 56],
    "completed implementations are never redispatched",
  );
  assert.deepEqual(
    [...fixture.writes].sort(),
    ["label:55", "assignee:55", "label:56", "assignee:56"].sort(),
  );
  const retained = await Promise.all(
    checkpoints.map((file) =>
      readFile(path.join(fixture.directory, "recovery", file), "utf8"),
    ),
  );
  assert.deepEqual(
    retained,
    original,
    "execution ownership, metadata and accepted evidence are retained",
  );
});

await test("changed configuration never adopts parent Reservations from a different input hash", async (t) => {
  const fixture = await parentRun(t, [child(51)]);
  await fixture.run();
  await writeFile(
    path.join(fixture.directory, "config.yaml"),
    stringify({
      ...validConfig,
      workflow: { review: false },
      maxBatchSize: 1,
    }),
  );
  const result = await fixture.run();
  assert.equal(result.summary.outcome, "incomplete");
  assert.match(
    result.summary.reasons.join("; "),
    /existing Reservations: 51 \(complete\)/u,
  );
  assert.deepEqual(fixture.dispatched, [51]);
  assert.deepEqual(fixture.writes, ["label:51", "assignee:51"]);
});

await test("failed assignee writes retain a partial Reservation without automatic compensation or later adoption", async (t) => {
  const children = [child(51)];
  const fixture = await parentRun(t, children);
  fixture.dependencies.tracker.addAssignee = async () => {
    throw new Error("assignee unavailable");
  };
  fixture.dependencies.operator.pause = async () => "q";
  const result = await fixture.run();
  assert.equal(result.summary.outcome, "cancelled");
  assert.deepEqual(children[0]!.labels, [
    "ready-for-agent",
    "sandcastle:reserved",
  ]);
  assert.deepEqual(children[0]!.assignees, []);
  assert.deepEqual(fixture.writes, ["label:51"]);
  assert.deepEqual(fixture.dispatched, []);
  const next = await fixture.run();
  assert.equal(next.summary.outcome, "incomplete");
  assert.match(
    next.summary.reasons.join("; "),
    /existing Reservations: 51 \(partial\)/u,
  );
  assert.deepEqual(fixture.writes, ["label:51"]);
});

await test("a lost write response is reconciled before retrying the same Reservation mutation", async (t) => {
  const fixture = await parentRun(t, [child(51)]);
  const addLabel = fixture.dependencies.tracker.addLabel.bind(
    fixture.dependencies.tracker,
  );
  fixture.dependencies.tracker.addLabel = async (...args) => {
    await addLabel(...args);
    throw new Error("response lost after label was added");
  };
  await fixture.run();
  assert.deepEqual(fixture.writes, ["label:51", "assignee:51"]);
  assert.deepEqual(fixture.dispatched, [51]);
});

for (const change of [
  "left_scope",
  "external",
  "blocked",
  "not_ready",
  "closed",
] as const) {
  await test(`parent stops dispatch and retains Reservation markers when a reserved child becomes ${change}`, async (t) => {
    const ticket = child(51);
    const fixture = await parentRun(t, [ticket]);
    const addAssignee = fixture.dependencies.tracker.addAssignee.bind(
      fixture.dependencies.tracker,
    );
    fixture.dependencies.tracker.addAssignee = async (...args) => {
      await addAssignee(...args);
      if (change === "external") ticket.assignees!.push("developer");
      if (change === "not_ready") ticket.labels = ["sandcastle:reserved"];
      if (change === "closed") {
        ticket.state = "closed";
        ticket.stateReason = "completed";
      }
    };
    if (change === "left_scope")
      fixture.dependencies.tracker.listChildrenPage = async () => ({
        children: fixture.writes.length === 2 ? [] : [structuredClone(ticket)],
        nextPage: null,
      });
    if (change === "blocked")
      fixture.dependencies.tracker.listBlockersPage = async () => ({
        blockers: fixture.writes.length === 2 ? [child(900)] : [],
        nextPage: null,
      });
    const result = await fixture.run();
    assert.equal(result.summary.outcome, "incomplete");
    assert.deepEqual(fixture.writes, ["label:51", "assignee:51"]);
    assert.deepEqual(fixture.dispatched, []);
    assert.ok(ticket.labels!.includes("sandcastle:reserved"));
  });
}

await test("a blocker-page failure after an open blocker cannot permit selection", async (t) => {
  const fixture = await parentRun(t, [child(51)]);
  const pages: number[] = [];
  fixture.dependencies.tracker.listBlockersPage = async (
    _repo,
    _number,
    page,
  ) => {
    pages.push(page);
    if (page === 2) throw new Error("incomplete blocker read");
    return { blockers: [child(900)], nextPage: 2 };
  };
  fixture.dependencies.operator.pause = async () => "q";
  assert.equal((await fixture.run()).summary.outcome, "cancelled");
  assert.deepEqual(pages, [1, 2, 2]);
  assert.deepEqual(fixture.writes, []);
  assert.deepEqual(fixture.dispatched, []);
});

for (const invalid of [
  "foreign_child",
  "child_page_cycle",
  "blocker_page_cycle",
  "blocker_closure",
  "child_closure",
] as const) {
  await test(`invalid parent discovery fails before Reservation: ${invalid}`, async (t) => {
    const ticket = child(51);
    const fixture = await parentRun(t, [ticket]);
    if (invalid === "foreign_child") ticket.repository = "outside/repo";
    if (invalid === "child_closure") {
      ticket.state = "closed";
      ticket.stateReason = null;
    }
    if (invalid === "child_page_cycle")
      fixture.dependencies.tracker.listChildrenPage = async () => ({
        children: [ticket],
        nextPage: 1,
      });
    if (invalid === "blocker_page_cycle" || invalid === "blocker_closure")
      fixture.dependencies.tracker.listBlockersPage = async () => ({
        blockers:
          invalid === "blocker_closure"
            ? [child(900, { state: "closed", stateReason: null })]
            : [],
        nextPage: invalid === "blocker_page_cycle" ? 1 : null,
      });
    const result = await fixture.run();
    assert.equal(result.summary.outcome, "failed");
    assert.deepEqual(fixture.writes, []);
    assert.deepEqual(fixture.dispatched, []);
    assert.match(
      result.summary.reasons.join("; "),
      /cross-repository|pagination|unsupported terminal state/u,
    );
  });
}

await test("a parent consumes retained handoff evidence for its recorded execution after interruption", async (t) => {
  const fixture = await parentRun(t, [child(51)]);
  const submitText = fixture.dependencies.terminalPlugin.submitText.bind(
    fixture.dependencies.terminalPlugin,
  );
  fixture.dependencies.terminalPlugin.submitText = async (tab, text) => {
    await submitText(tab, text);
    if (text.startsWith("Implementation assignment\n"))
      fixture.controller.abort();
  };
  assert.equal((await fixture.run()).summary.outcome, "cancelled");
  const [checkpoint] = (
    await readdir(path.join(fixture.directory, "recovery"))
  ).filter((file) => file.endsWith("-51.json"));
  const file = path.join(fixture.directory, "recovery", checkpoint!);
  const before = JSON.parse(await readFile(file, "utf8")) as Record<
    string,
    unknown
  >;
  assert.equal(before.phase, "implementing");
  fixture.dependencies.signal = new AbortController().signal;
  assert.equal((await fixture.run()).summary.outcome, "incomplete");
  const after = JSON.parse(await readFile(file, "utf8")) as Record<
    string,
    unknown
  >;
  assert.equal(after.phase, "implementation_completed");
  assert.equal(after.execution_id, before.execution_id);
  assert.equal(after.run_id, before.run_id);
  assert.deepEqual(after.roles, before.roles);
  assert.deepEqual(fixture.dispatched, [51]);
  assert.deepEqual(fixture.writes, ["label:51", "assignee:51"]);
});

await test("cancellation after one child completes prevents subsequent Batch dispatch", async (t) => {
  const fixture = await parentRun(t, [child(51), child(52)], {
    ...validConfig,
    maxBatchSize: 1,
  });
  fixture.dependencies.terminalPlugin.closeTab = async () => {
    fixture.controller.abort();
  };
  assert.equal((await fixture.run()).summary.outcome, "cancelled");
  assert.deepEqual(fixture.dispatched, [51]);
  assert.deepEqual(fixture.writes, ["label:51", "assignee:51"]);
});
