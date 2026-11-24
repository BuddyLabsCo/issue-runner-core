/* eslint-disable @typescript-eslint/require-await -- Scripted external boundaries. */
import assert from "node:assert/strict";
import test from "node:test";
import { validConfig } from "../support/cli-project.ts";
import { child, parentRun } from "../support/parent-run.ts";

const label = validConfig.tracker.reservationLabel;
const reservation = { name: label, id: "resolved-label-id" };

async function reservationRun(
  t: Parameters<typeof parentRun>[0],
  {
    existing = false,
    eligible = true,
    runnerResolved = true,
    creation = "success",
    assigneeAfterCreation,
  }: {
    existing?: boolean;
    eligible?: boolean;
    runnerResolved?: boolean;
    creation?: "success" | "concurrent" | "rejected";
    assigneeAfterCreation?: string;
  } = {},
) {
  const ticket = child(51, eligible ? {} : { labels: [] });
  const fixture = await parentRun(t, [ticket]);
  const { tracker } = fixture.dependencies;
  const effects: string[] = [];
  const labelPages: number[] = [];
  let exists = existing;
  const discover = tracker.discoverParent.bind(tracker);
  tracker.discoverParent = async (...args) => {
    effects.push("discover");
    const facts = await discover(...args);
    return {
      ...facts,
      viewer: runnerResolved ? facts.viewer : null,
      reservation: exists ? reservation : null,
    };
  };
  tracker.listLabelsPage = async (_repository, page) => {
    labelPages.push(page);
    return {
      labels: page === 2 && exists ? [label] : [],
      nextPage: page === 1 ? 2 : null,
    };
  };
  tracker.createLabel = async (repository, name) => {
    assert.equal(repository, validConfig.repository);
    assert.equal(name, label);
    effects.push("create");
    if (creation === "rejected") throw new Error("Create label denied");
    exists = true;
    if (assigneeAfterCreation) ticket.assignees = [assigneeAfterCreation];
    if (creation === "concurrent") throw new Error("Label already exists");
  };
  const start = tracker.readIssueStart.bind(tracker);
  tracker.readIssueStart = async (...args) => {
    effects.push("start");
    const facts = await start(...args);
    return {
      ...facts,
      viewer: runnerResolved ? facts.viewer : null,
      reservation: exists ? reservation : null,
    };
  };
  const reserve = tracker.reserveIssue.bind(tracker);
  tracker.reserveIssue = async (additions, signal) => {
    assert.deepEqual(additions.reservation, reservation);
    effects.push("reserve");
    const confirmed = await reserve(additions, signal);
    return {
      ...confirmed,
      labels: confirmed.labels.map((marker) =>
        marker.name === label ? reservation : marker,
      ),
    };
  };
  return { ...fixture, effects, labelPages };
}

for (const [scope, args, expected] of [
  [
    "Parent discovery",
    ["--parent", "48"],
    ["discover", "create", "discover", "start", "reserve"],
  ],
  [
    "Standalone Issue start",
    ["--issue", "51"],
    ["start", "create", "start", "reserve"],
  ],
] as const) {
  await test(`${scope} creates a missing Reservation label before reserving the Issue`, async (t) => {
    const fixture = await reservationRun(t);

    await fixture.run([...args]);

    assert.deepEqual(fixture.effects, expected);
    assert.deepEqual(fixture.writes, ["label:51", "assignee:51"]);
    assert.deepEqual(fixture.dispatched, [51]);
  });

  for (const [condition, options, dispatched] of [
    ["the label already exists", { existing: true }, [51]],
    ["the viewer is unresolved", { runnerResolved: false }, []],
    ["there is no eligible Issue", { eligible: false }, []],
  ] as const) {
    await test(`${scope} skips label creation when ${condition}`, async (t) => {
      const fixture = await reservationRun(t, options);
      const unresolved = "runnerResolved" in options && !options.runnerResolved;
      const { operator, pauses } = fixture.dependencies;
      if (unresolved)
        operator.pause = async (message) => {
          pauses.push(message);
          return "q";
        };

      const { summary } = await fixture.run([...args]);

      assert.equal(summary.outcome, unresolved ? "cancelled" : "incomplete");
      if (unresolved) {
        assert.equal(pauses.length, 1);
        assert.match(
          pauses[0]!,
          /did not resolve the configured Reservation label or authenticated viewer|authenticated as a normal GitHub user/u,
        );
      } else assert.deepEqual(pauses, []);
      assert.ok(!fixture.effects.includes("create"));
      assert.deepEqual(fixture.dispatched, dispatched);
      if (!dispatched.length) assert.deepEqual(fixture.writes, []);
    });
  }
}

await test("Standalone Issue start rechecks ownership after creating the Reservation label", async (t) => {
  const fixture = await reservationRun(t, {
    assigneeAfterCreation: "developer",
  });

  const { summary } = await fixture.run(["--issue", "51"]);

  assert.equal(summary.outcome, "incomplete");
  assert.match(summary.tickets![0]!.detail, /Issue is externally owned/u);
  assert.deepEqual(fixture.effects, ["start", "create", "start"]);
  assert.deepEqual(fixture.writes, []);
  assert.deepEqual(fixture.dispatched, []);
});

await test("Standalone Issue start reconciles a concurrent label creation before reserving", async (t) => {
  const fixture = await reservationRun(t, { creation: "concurrent" });

  await fixture.run(["--issue", "51"]);

  assert.deepEqual(fixture.labelPages, [1, 2, 1, 2]);
  assert.deepEqual(fixture.effects, ["start", "create", "start", "reserve"]);
  assert.deepEqual(fixture.dispatched, [51]);
});

await test("Standalone Issue start retries and pauses when label creation fails and the label remains absent", async (t) => {
  const fixture = await reservationRun(t, { creation: "rejected" });

  await fixture.run(["--issue", "51"]);

  assert.deepEqual(fixture.labelPages, [1, 2, 1, 2, 1, 2, 1, 2]);
  assert.deepEqual(fixture.effects, ["start", "create", "start", "create"]);
  assert.deepEqual(fixture.dispatched, []);
  assert.match(fixture.dependencies.pauses.join("\n"), /Create label denied/u);
});
