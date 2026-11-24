/* eslint-disable @typescript-eslint/require-await -- Scripted external boundaries. */
import assert from "node:assert/strict";
import { access, readFile, readdir } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { validConfig } from "../support/cli-project.ts";
import { child, parentDeliveryRun, parentRun } from "../support/parent-run.ts";
import type { ParentDiscovery } from "../../src/run/contracts.ts";
import { implementationProgress } from "../support/implementation-run.ts";
import { updateConfig } from "../support/run-scope.ts";

await test("parent discovery seeds the viewer cache without a viewer-only query", async (t) => {
  const fixture = await parentRun(t, [child(51)]);
  fixture.dependencies.tracker.readViewer = async () =>
    assert.fail("parent discovery already returns the authenticated viewer");

  assert.equal((await fixture.run()).summary.outcome, "incomplete");
  assert.deepEqual(fixture.dispatched, [51]);
});

for (const [selector, numbers] of [
  ["parent", [51, 52]],
  ["parent", [51]],
  ["issue", [51, 52]],
] as const) {
  await test(`${selector} saved Batch recovery with ${numbers.length} discovered ${numbers.length === 1 ? "Issue" : "Issues"} completes delivery`, async (t) => {
    const fixture = await parentDeliveryRun(
      t,
      numbers.map((number) => child(number)),
      {
        ...validConfig,
        issueList: [...numbers],
        maxBatchSize: 1,
      },
    );
    const scope = [`--${selector}`, ...(selector === "parent" ? ["48"] : [])];
    const addLabel = fixture.dependencies.tracker.addLabel.bind(
      fixture.dependencies.tracker,
    );
    fixture.dependencies.tracker.addLabel = async () => {
      fixture.controller.abort();
    };
    assert.equal((await fixture.run(scope)).summary.outcome, "cancelled");
    fixture.dependencies.tracker.addLabel = addLabel;
    fixture.dependencies.signal = new AbortController().signal;

    const result = await fixture.run(scope);

    assert.equal(result.summary.outcome, "succeeded", JSON.stringify(result));
    assert.deepEqual(fixture.dispatched, [...numbers]);
    assert.deepEqual(fixture.closures, [
      ...numbers,
      ...(selector === "parent" ? [48] : []),
    ]);
  });
}

await test("an empty discovered parent scope has no work", async (t) => {
  const fixture = await parentRun(t, [], {
    ...validConfig,
    issueList: [51],
  });

  const result = await fixture.run();

  assert.equal(result.summary.outcome, "no_work");
});

await test("parent selects the numerically first eligible Issue from its complete discovery facts", async (t) => {
  const fixture = await parentRun(
    t,
    [child(60), child(53), child(52), child(51)],
    {
      ...validConfig,
      maxBatchSize: 1,
    },
  );
  const identity = (number: number) => ({
    id: `issue-${number}`,
    number,
    repository: "owner/repo",
    repositoryId: "repo-id",
    state: "open" as const,
    stateReason: null,
  });
  const ready = { id: "ready-id", name: "ready-for-agent" };
  const facts: ParentDiscovery = {
    parent: identity(48),
    children: [
      { ...identity(60), labels: [ready], assignees: [], blockers: [] },
      { ...identity(53), labels: [ready], assignees: [], blockers: [] },
      {
        ...identity(51),
        labels: [ready],
        assignees: [],
        blockers: [identity(900)],
      },
      {
        ...identity(52),
        labels: [ready],
        assignees: [{ id: "external-id", login: "developer" }],
        blockers: [],
      },
    ],
    reservation: { id: "reserved-id", name: "sandcastle:reserved" },
    viewer: { id: "runner-id", login: "runner" },
  };
  Object.assign(fixture.dependencies.tracker, {
    async discoverParent() {
      return facts;
    },
  });
  fixture.dependencies.tracker.listBlockersPage = async (_repo, number) => {
    assert.equal(
      number,
      53,
      "only the selected Issue needs a separate start read",
    );
    return { blockers: [], nextPage: null };
  };

  const result = await fixture.run();

  assert.equal(result.summary.outcome, "incomplete", JSON.stringify(result));
  assert.deepEqual(fixture.dispatched, [53]);
  assert.deepEqual(fixture.writes, ["label:53", "assignee:53"]);
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
  const { tracker } = fixture.dependencies;
  const reserveIssue = tracker.reserveIssue.bind(tracker);
  tracker.reserveIssue = async (...args) => {
    assert.ok(
      blockerPages.includes("60:2"),
      "complete discovery precedes Reservations",
    );
    return reserveIssue(...args);
  };
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
  await fixture.run();
  assert.deepEqual(
    [...fixture.dispatched].sort((a, b) => a - b),
    [54, 57, 60],
  );
  assert.deepEqual(
    [...fixture.writes].sort(),
    ["label:54", "label:57", "assignee:57", "label:60", "assignee:60"].sort(),
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
});

await test("start rejects a foreign sibling that appears on a later page after discovery", async (t) => {
  const ticket = child(51);
  const fixture = await parentRun(t, [ticket]);
  const { tracker } = fixture.dependencies;
  const list = tracker.listChildrenPage.bind(tracker);
  const discover = tracker.discoverParent.bind(tracker);
  tracker.discoverParent = async (...args) => {
    const facts = await discover(...args);
    tracker.listChildrenPage = async (repository, parent, page) =>
      page === 1
        ? { ...(await list(repository, parent, page)), nextPage: 2 }
        : {
            children: [child(70, { repository: "outside/repo" })],
            nextPage: null,
          };
    return facts;
  };
  const result = await fixture.run();
  assert.equal(result.summary.outcome, "failed");
  assert.match(
    result.summary.failure!,
    /cross-repository child outside\/repo#70/u,
  );
  assert.deepEqual(fixture.writes, []);
  assert.deepEqual(fixture.dispatched, []);
});

await test("conflicting child state on a membership page triggers a fresh start before any write", async (t) => {
  const ticket = child(51);
  const fixture = await parentRun(t, [ticket]);
  const { tracker, clock } = fixture.dependencies;
  let retried = false;
  const discover = tracker.discoverParent.bind(tracker);
  tracker.discoverParent = async (...args) => {
    const facts = await discover(...args);
    tracker.listChildrenPage = async (_repository, _parent, page) =>
      page === 1
        ? { children: [], nextPage: 2 }
        : {
            children: [
              retried
                ? structuredClone(ticket)
                : child(51, { state: "closed", stateReason: "not_planned" }),
            ],
            nextPage: null,
          };
    return facts;
  };
  clock.sleep = async (ms) => {
    if (ms !== 1_000 || retried) return;
    assert.deepEqual(fixture.writes, []);
    retried = true;
  };
  const { summary } = await fixture.run();
  assert.equal(summary.outcome, "incomplete", JSON.stringify(summary));
  assert.equal(retried, true);
  assert.deepEqual(fixture.writes, ["label:51", "assignee:51"]);
  assert.deepEqual(fixture.dispatched, [51]);
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

await test("a changed Parent scope never adopts a Reservation and retains recorded work", async (t) => {
  const fixture = await parentRun(t, [child(51)], {
    ...validConfig,
    issueList: [51],
  });
  await fixture.run();
  const saved = await implementationProgress(fixture.directory, 51);
  const recovery = path.join(fixture.directory, "recovery");
  const batchFile = (await readdir(recovery)).find((file) =>
    file.endsWith("-batch.json"),
  )!;
  const batch = await readFile(path.join(recovery, batchFile), "utf8");
  const cleanups: string[] = [];
  const cleanup = fixture.dependencies.gitWorkspace.cleanupWorktree.bind(
    fixture.dependencies.gitWorkspace,
  );
  fixture.dependencies.gitWorkspace.cleanupWorktree = async (input) => {
    cleanups.push(input.worktree);
    return cleanup(input);
  };
  await updateConfig(fixture, (config) => ({
    ...config,
    issueList: [],
  }));
  fixture.dependencies.signal = new AbortController().signal;

  const result = await fixture.run();

  assert.equal(result.summary.outcome, "incomplete");
  assert.deepEqual(result.summary.tickets, []);
  assert.deepEqual(fixture.writes, ["label:51", "assignee:51"]);
  assert.equal(await readFile(path.join(recovery, batchFile), "utf8"), batch);
  assert.equal(
    (await implementationProgress(fixture.directory, 51)).execution_id,
    saved.execution_id,
  );
  await access(saved.worktree);
  assert.deepEqual(cleanups, []);
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
    next.summary.tickets![0]!.detail,
    /existing Reservation \(partial\); no recorded ownership for this Run/u,
  );
  assert.deepEqual(fixture.writes, ["label:51"]);
  assert.deepEqual(fixture.dispatched, []);
});

await test("lost readiness after Reservation prevents dispatch and retains ownership markers", async (t) => {
  const ticket = child(51);
  const fixture = await parentDeliveryRun(t, [ticket]);
  const assign = fixture.dependencies.tracker.addAssignee.bind(
    fixture.dependencies.tracker,
  );
  fixture.dependencies.tracker.addAssignee = async (...args) => {
    await assign(...args);
    ticket.labels = ["sandcastle:reserved"];
  };
  assert.equal((await fixture.run()).summary.outcome, "incomplete");
  assert.deepEqual(fixture.closures, []);
  assert.deepEqual(fixture.writes, ["label:51", "assignee:51"]);
  assert.deepEqual(fixture.dispatched, []);
  assert.deepEqual(ticket.labels, ["sandcastle:reserved"]);
});

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
  assert.deepEqual(pages, [1, 2, 1, 2]);
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
      result.summary.failure!,
      /cross-repository|pagination|unsupported terminal state/u,
    );
  });
}

await test("a parent consumes retained handoff evidence for its recorded execution after interruption", async (t) => {
  const fixture = await parentRun(t, [child(51)]);
  const submitText = fixture.dependencies.terminalPlugin.onInput.bind(
    fixture.dependencies.terminalPlugin,
  );
  fixture.dependencies.terminalPlugin.onInput = async (tab, text) => {
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
