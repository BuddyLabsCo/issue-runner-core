/* eslint-disable @typescript-eslint/require-await -- Scripted external boundaries. */
import assert from "node:assert/strict";
import { readFile, readdir, writeFile } from "node:fs/promises";
import path from "node:path";
import test, { type TestContext } from "node:test";
import { stringify } from "yaml";
import { executeCli } from "../../src/cli.ts";
import type { Ticket } from "../../src/run/contracts.ts";
import { createProject, validConfig } from "../support/cli-project.ts";
import { createCliDependencies } from "../support/cli-dependencies.ts";
import { publish } from "../support/implementation-run.ts";
import { child, parentRun } from "../support/parent-run.ts";

async function issueListRun(
  t: TestContext,
  tickets: Ticket[],
  issueList = tickets.map((ticket) => ticket.number),
  maxBatchSize = 3,
) {
  const fixture = await parentRun(t, tickets, {
    ...validConfig,
    issueList,
    maxBatchSize,
  });
  fixture.dependencies.tracker.getParent = async () =>
    assert.fail("an Issue List has no parent scope");
  fixture.dependencies.tracker.listChildrenPage = async () =>
    assert.fail("an Issue List does not discover children");
  return {
    ...fixture,
    run: (scope = ["--issue"]) => fixture.run(scope),
  };
}

await test("an explicit Issue List dispatches only selected Issues in ascending order up to the Batch size without parent discovery", async (t) => {
  const fixture = await issueListRun(
    t,
    [child(54), child(51), child(53), child(52)],
    [54, 53, 51],
    2,
  );
  const requested: number[] = [];
  const getTicket = fixture.dependencies.tracker.getTicket.bind(
    fixture.dependencies.tracker,
  );
  fixture.dependencies.tracker.getTicket = async (repository, number) => {
    requested.push(number);
    return getTicket(repository, number);
  };

  const result = await fixture.run(["--issue"]);

  assert.deepEqual(fixture.dispatched, [51, 53]);
  assert.deepEqual([...new Set(requested)], [51, 53, 54]);
  assert.deepEqual(fixture.writes, [
    "label:51",
    "assignee:51",
    "label:53",
    "assignee:53",
  ]);
  assert.equal(result.summary.outcome, "incomplete");
  assert.equal(result.exitCode, 1);
  assert.equal(result.summary.targetBranch, "default-branch");
  assert.match(
    result.summary.reasons.join("; "),
    /selected Delivery Tickets: 51, 53/u,
  );
});

await test("list discovery filters blocked, externally owned, unready and reserved work before filling the Batch", async (t) => {
  const fixture = await issueListRun(
    t,
    [
      child(51),
      child(52, { assignees: ["developer"] }),
      child(53, { labels: ["ready-for-agent", "sandcastle:reserved"] }),
      child(54, { assignees: ["runner"] }),
      child(55, {
        labels: ["ready-for-agent", "sandcastle:reserved"],
        assignees: ["runner"],
      }),
      child(56, { labels: ["Ready-For-Agent"] }),
      child(57, { labels: ["ready-for-agent", "backlog"] }),
      child(59, { state: "closed", stateReason: "not_planned" }),
      child(60),
    ],
    undefined,
    2,
  );
  const pages: string[] = [];
  fixture.dependencies.tracker.listBlockersPage = async (
    _repository,
    number,
    page,
  ) => {
    if (!fixture.writes.length) pages.push(`${number}:${page}`);
    return {
      blockers:
        number === 51 || number === 60
          ? [
              child(900 + page, {
                repository: "outside/repo",
                ...(number === 51 && page === 2
                  ? {}
                  : {
                      state: "closed",
                      stateReason: page === 1 ? "completed" : "not_planned",
                    }),
              }),
            ]
          : [],
      nextPage: (number === 51 || number === 60) && page === 1 ? 2 : null,
    };
  };

  const result = await fixture.run();

  assert.deepEqual(fixture.dispatched, [57, 60]);
  assert.deepEqual(
    [...new Set(pages)],
    [
      "51:1",
      "51:2",
      "52:1",
      "53:1",
      "54:1",
      "55:1",
      "56:1",
      "57:1",
      "59:1",
      "60:1",
      "60:2",
    ],
  );
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
});

await test("a list of completed and cancelled Issues reports no_work without delivery mutations", async (t) => {
  const fixture = await issueListRun(t, [
    child(51, { state: "closed", stateReason: "completed" }),
    child(52, { state: "closed", stateReason: "not_planned" }),
  ]);
  const result = await fixture.run();
  assert.equal(result.summary.outcome, "no_work");
  assert.equal(result.exitCode, 0);
  assert.deepEqual(fixture.writes, []);
  assert.deepEqual(fixture.dispatched, []);
});

await test("unready open list Issues report incomplete rather than no_work", async (t) => {
  const fixture = await issueListRun(t, [child(51, { labels: [] })]);
  const result = await fixture.run();
  assert.equal(result.summary.outcome, "incomplete");
  assert.equal(result.exitCode, 1);
  assert.deepEqual(fixture.writes, []);
  assert.deepEqual(fixture.dispatched, []);
});

await test("a numbered standalone Issue overrides the configured list", async (t) => {
  const fixture = await issueListRun(t, [child(51), child(52)], [51]);
  fixture.dependencies.tracker.getTicket = async (_repository, number) => {
    assert.equal(number, 52, "the configured list is not consulted");
    return child(52, {
      labels: [
        "ready-for-agent",
        ...(fixture.writes.length ? ["sandcastle:reserved"] : []),
      ],
      assignees: fixture.writes.length === 2 ? ["runner"] : [],
    });
  };
  const result = await fixture.run(["--issue", "52", "--no-auto-merge"]);
  assert.deepEqual(fixture.dispatched, [52]);
  assert.equal(result.summary.outcome, "incomplete");
});

await test("list option ordering preserves the configured Target Branch", async (t) => {
  const fixture = await issueListRun(t, [child(51)]);
  await writeFile(
    path.join(fixture.directory, "config.yaml"),
    stringify({
      ...validConfig,
      workflow: { review: false },
      issueList: [51],
      targetBranch: "release",
    }),
  );
  fixture.dependencies.codeHost.resolveTargetBranch = async () =>
    assert.fail("the configured Target Branch wins");
  const result = await executeCli(
    ["run", "--issue", "--env", "fake", "--project", "demo"],
    fixture.dependencies,
  );
  assert.deepEqual(fixture.dispatched, [51]);
  assert.equal(result.summary.targetBranch, "release");
});

await test("empty and invalid lists fail at startup before external reads or delivery resources", async (t) => {
  for (const issueList of [
    [],
    [51, 51],
    [0],
    [-1],
    [1.5],
    [Number.MAX_SAFE_INTEGER + 1],
    ["51"],
    "51",
  ]) {
    const { root } = await createProject(t, { ...validConfig, issueList });
    const deps = createCliDependencies(root);
    const result = await executeCli(
      ["run", "--issue", "--env", "fake", "--project", "demo"],
      deps,
    );
    assert.equal(result.summary.outcome, "failed");
    assert.equal(result.logPath, null);
    assert.match(result.summary.reasons.join("; "), /issueList/u);
    assert.deepEqual(deps.reads, []);
    assert.deepEqual(deps.effects, []);
  }
});

await test("a list with a missing Issue cannot dispatch earlier eligible work from an incomplete discovery", async (t) => {
  const fixture = await issueListRun(t, [child(51)], [51, 999]);
  const getTicket = fixture.dependencies.tracker.getTicket.bind(
    fixture.dependencies.tracker,
  );
  fixture.dependencies.tracker.getTicket = async (repository, number) => {
    if (number === 999) throw new Error("Issue 999 not found");
    return getTicket(repository, number);
  };
  fixture.dependencies.operator.pause = async () => "q";
  const result = await fixture.run();
  assert.equal(result.summary.outcome, "cancelled");
  assert.deepEqual(fixture.writes, []);
  assert.deepEqual(fixture.dispatched, []);
});

await test("an incomplete blocker read fails closed before any list Reservation", async (t) => {
  const fixture = await issueListRun(t, [child(51), child(52)]);
  fixture.dependencies.tracker.listBlockersPage = async (
    _repository,
    number,
    page,
  ) => {
    if (page === 2) throw new Error("blocker read unavailable");
    return { blockers: [], nextPage: number === 52 ? 2 : null };
  };
  fixture.dependencies.operator.pause = async () => "q";
  const result = await fixture.run();
  assert.equal(result.summary.outcome, "cancelled");
  assert.deepEqual(fixture.writes, []);
  assert.deepEqual(fixture.dispatched, []);
});

await test("list discovery rejects unexpected Issue identity or unsupported terminal state before Reservation", async (t) => {
  for (const ticket of [
    child(999),
    child(52, { repository: "outside/repo" }),
    child(52, { state: "closed", stateReason: null }),
  ]) {
    const fixture = await issueListRun(t, [child(51), child(52)]);
    const getTicket = fixture.dependencies.tracker.getTicket.bind(
      fixture.dependencies.tracker,
    );
    fixture.dependencies.tracker.getTicket = async (repository, number) =>
      number === 52 ? ticket : getTicket(repository, number);
    const result = await fixture.run();
    assert.equal(result.summary.outcome, "failed");
    assert.deepEqual(fixture.writes, []);
    assert.deepEqual(fixture.dispatched, []);
  }
});

await test("list recovery preserves recorded ownership and verified completion without redispatch or adopting residual Reservations", async (t) => {
  const fixture = await issueListRun(t, [
    child(51, {
      labels: ["ready-for-agent", "sandcastle:reserved"],
      assignees: ["runner"],
    }),
    child(55),
    child(56),
  ]);
  await fixture.run();
  const recovery = path.join(fixture.directory, "recovery");
  const files = await readdir(recovery);
  const original = await Promise.all(
    files.map((file) => readFile(path.join(recovery, file), "utf8")),
  );
  const result = await fixture.run();
  assert.equal(result.summary.outcome, "incomplete");
  assert.deepEqual(fixture.dispatched, [55, 56]);
  assert.deepEqual(fixture.writes, [
    "label:55",
    "assignee:55",
    "label:56",
    "assignee:56",
  ]);
  assert.deepEqual(
    await Promise.all(
      files.map((file) => readFile(path.join(recovery, file), "utf8")),
    ),
    original,
  );

  await writeFile(
    path.join(fixture.directory, "config.yaml"),
    stringify({
      ...validConfig,
      workflow: { review: false },
      issueList: [51, 55, 56],
      maxBatchSize: 1,
    }),
  );
  const changed = await fixture.run();
  assert.equal(changed.summary.outcome, "incomplete");
  assert.match(
    changed.summary.reasons.join("; "),
    /existing Reservations: 51 \(complete\), 55 \(complete\), 56 \(complete\)/u,
  );
  assert.deepEqual(fixture.dispatched, [55, 56]);
});

await test("cancellation during a list assignment stops later dispatch and preserves handoff evidence for recovery", async (t) => {
  const fixture = await issueListRun(t, [child(51), child(52)]);
  const submitText = fixture.dependencies.terminalPlugin.submitText.bind(
    fixture.dependencies.terminalPlugin,
  );
  fixture.dependencies.terminalPlugin.submitText = async (tab, text) => {
    await submitText(tab, text);
    if (text.startsWith("Implementation assignment\n"))
      fixture.controller.abort();
  };
  assert.equal((await fixture.run()).summary.outcome, "cancelled");
  assert.deepEqual(fixture.dispatched, [51]);
  assert.deepEqual(fixture.writes, ["label:51", "assignee:51"]);
  const [file] = await readdir(path.join(fixture.directory, "recovery"));
  const checkpoint = path.join(fixture.directory, "recovery", file!);
  const before = JSON.parse(await readFile(checkpoint, "utf8")) as Record<
    string,
    unknown
  >;
  assert.equal(before.phase, "implementing");
  fixture.dependencies.signal = new AbortController().signal;
  fixture.dependencies.terminalPlugin.submitText = submitText;
  assert.equal((await fixture.run()).summary.outcome, "incomplete");
  const after = JSON.parse(await readFile(checkpoint, "utf8")) as Record<
    string,
    unknown
  >;
  assert.equal(after.phase, "implementation_completed");
  assert.equal(after.execution_id, before.execution_id);
  assert.equal(after.run_id, before.run_id);
  assert.deepEqual(after.roles, before.roles);
  assert.deepEqual(fixture.dispatched, [51, 52]);
});

await test("a verified no_change list implementation remains incomplete and retains its checkpoint", async (t) => {
  const fixture = await issueListRun(t, [child(51)]);
  const submitText = fixture.dependencies.terminalPlugin.submitText.bind(
    fixture.dependencies.terminalPlugin,
  );
  fixture.dependencies.terminalPlugin.submitText = async (tab, text) => {
    if (text.startsWith("Implementation assignment\n")) {
      const assignment = JSON.parse(text.split("\n")[1]!) as { path: string };
      await publish(assignment.path, {
        outcome: "no_change",
        summary: "No implementation change needed.",
        commits: [],
        findings_file: null,
      });
    } else await submitText(tab, text);
  };
  const result = await fixture.run();
  assert.equal(result.summary.outcome, "incomplete");
  assert.match(
    result.summary.reasons.join("; "),
    /no_change; no Issue delivery/u,
  );
  const [file] = await readdir(path.join(fixture.directory, "recovery"));
  const checkpoint = JSON.parse(
    await readFile(path.join(fixture.directory, "recovery", file!), "utf8"),
  ) as Record<string, unknown>;
  assert.equal(checkpoint.phase, "implementation_completed");
  assert.equal((checkpoint.result as { outcome: string }).outcome, "no_change");
});
