import assert from "node:assert/strict";
import test from "node:test";
import { loadProject } from "../../src/config.ts";
import { createProject, validConfig } from "../support/cli-project.ts";
import { child, parentRun } from "../support/parent-run.ts";

const { issueLabel, ...withoutIssueLabel } = validConfig;

for (const [name, labelConfig, labels, selected] of [
  ["template default", { issueLabel }, [issueLabel], true],
  ["custom label", { issueLabel: " queued " }, ["queued"], true],
  ["wrong label", { issueLabel: "queued" }, ["ready-for-agent"], false],
  ["case mismatch", { issueLabel: "queued" }, ["Queued"], false],
  ["missing label", { issueLabel: "queued" }, [], false],
  ["empty label", { issueLabel: "" }, [], true],
  ["omitted label", {}, [], true],
  ["whitespace label", { issueLabel: "   " }, [], true],
] as const) {
  for (const scope of [["--parent", "48"], ["--issue"], ["--issue", "51"]]) {
    await test(`issueLabel ${name} with ${scope.join(" ")}`, async (t) => {
      const fixture = await parentRun(t, [child(51, { labels: [...labels] })], {
        ...withoutIssueLabel,
        ...labelConfig,
        issueList: [51],
      });
      const result = await fixture.run(scope);
      assert.equal(
        result.summary.outcome,
        "incomplete",
        JSON.stringify(result),
      );
      assert.deepEqual(fixture.dispatched, selected ? [51] : []);
      if (!selected) assert.deepEqual(fixture.writes, []);
    });
  }
}

await test("omitted issueLabel loads without a label restriction", async (t) => {
  const { root } = await createProject(t, withoutIssueLabel);
  const { config } = await loadProject(root, "demo", {
    HOST_TOKEN: "host",
  });
  assert.equal(config.issueLabel, "");
});

await test("a missing issueLabel in the Reservation response prevents Worktree creation", async (t) => {
  const ticket = child(51, { labels: ["queued"] });
  const fixture = await parentRun(t, [ticket], {
    ...validConfig,
    issueLabel: "queued",
  });
  const addAssignee = fixture.dependencies.tracker.addAssignee.bind(
    fixture.dependencies.tracker,
  );
  fixture.dependencies.tracker.addAssignee = async (...args) => {
    await addAssignee(...args);
    ticket.labels = ticket.labels!.filter((label) => label !== "queued");
  };
  fixture.dependencies.gitWorkspace.createWorktree = () =>
    assert.fail("unexpected Worktree creation");
  const result = await fixture.run(["--issue", "51"]);
  assert.equal(result.summary.outcome, "incomplete");
  assert.match(result.summary.tickets![0]!.detail, /Issue is missing queued/u);
  assert.deepEqual(fixture.dispatched, []);
});

await test("a Reservation response with the wrong Runner ID prevents Worktree creation", async (t) => {
  const fixture = await parentRun(t, [child(51)]);
  const { tracker, gitWorkspace } = fixture.dependencies;
  const reserve = tracker.reserveIssue.bind(tracker);
  tracker.reserveIssue = async (...args) => {
    const confirmed = await reserve(...args);
    return {
      ...confirmed,
      assignees: confirmed.assignees.map((runner) => ({
        ...runner,
        id: "another-account",
      })),
    };
  };
  gitWorkspace.createWorktree = () =>
    assert.fail("unexpected Worktree creation");
  const result = await fixture.run(["--issue", "51"]);
  assert.equal(result.summary.outcome, "incomplete");
  assert.match(
    result.summary.tickets![0]!.detail,
    /Issue is externally owned/u,
  );
});

await test("a differently capitalized Runner login needs only the label and can dispatch", async (t) => {
  const fixture = await parentRun(
    t,
    [child(51, { assignees: ["RunnerBot"] })],
    {
      ...validConfig,
      tracker: { ...validConfig.tracker, runnerAccount: "runnerbot" },
    },
  );
  assert.equal((await fixture.run()).summary.outcome, "incomplete");
  assert.deepEqual(fixture.writes, ["label:51"]);
  assert.deepEqual(fixture.dispatched, [51]);
});

await test("standalone Issue starts and dispatches with a differently capitalized repository name", async (t) => {
  const fixture = await parentRun(t, [child(51)], {
    ...validConfig,
    repository: "OWNER/Repo",
  });
  const result = await fixture.run(["--issue", "51"]);
  assert.equal(
    result.summary.outcome,
    "incomplete",
    JSON.stringify(result.summary),
  );
  assert.deepEqual(fixture.dispatched, [51]);
});
