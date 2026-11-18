import assert from "node:assert/strict";
import { test } from "node:test";
import { GitHubTracker } from "../../src/adapters/github-tracker.ts";
import type { GitHubCommand } from "../../src/adapters/github-client.ts";

const repo = { id: "repo", nameWithOwner: "owner/repo" };
const issue = (
  id: string,
  number: number,
  state = "OPEN",
  stateReason: string | null = null,
) => ({ id, number, state, stateReason, repository: repo });
const page = (nodes: unknown[], cursor: string | null = null) => ({
  nodes,
  pageInfo: { hasNextPage: cursor !== null, endCursor: cursor },
});
const child = (id: string, number: number) => ({
  ...issue(id, number),
  labels: page([]),
  assignees: page([]),
  blockedBy: page([]),
});
const initial = (children: unknown[], cursor: string | null = null) => ({
  data: {
    repository: {
      ...repo,
      label: { id: "label-id", name: "reserved" },
      issue: { ...issue("parent", 10), subIssues: page(children, cursor) },
    },
    user: { id: "runner-id", login: "runner" },
  },
});
function tracker(responses: unknown[]) {
  const calls: { query: string; variables: Record<string, unknown> }[] = [];
  const command: GitHubCommand = (_args, options) => {
    calls.push(JSON.parse(options.input!) as (typeof calls)[number]);
    assert.ok(responses.length, "unexpected request");
    return Promise.resolve(JSON.stringify(responses.shift()));
  };
  return { adapter: new GitHubTracker("token", command), calls };
}

await test("discovery drains each owner's connection before returning selection facts", async () => {
  const first = child("one", 11);
  first.labels = page([{ id: "ready", name: "ready" }], "label-cursor");
  first.blockedBy = page([], "blocker-cursor");
  const second = child("two", 12);
  second.assignees = page([{ id: "other", login: "other" }]);
  const script = tracker([
    initial([first], "children-cursor"),
    { data: { node: { id: "parent", subIssues: page([second]) } } },
    {
      data: {
        node: {
          id: "one",
          labels: page([{ id: "reserved-id", name: "reserved" }]),
        },
      },
    },
    { data: { node: { id: "one", blockedBy: page([issue("blocker", 99)]) } } },
  ]);
  const result = await script.adapter.discoverParent(
    "owner/repo",
    10,
    "runner",
    "reserved",
  );
  assert.deepEqual(
    result.tickets.map((ticket) => ticket.number),
    [11, 12],
  );
  assert.deepEqual(result.tickets[0]!.labels, ["ready", "reserved"]);
  assert.equal(result.tickets[0]!.blockers![0]!.number, 99);
  assert.deepEqual(result.tickets[1]!.assignees, ["other"]);
  assert.equal(result.reservationId, "label-id");
  assert.deepEqual(
    script.calls.slice(1).map((call) => call.variables),
    [
      { id: "parent", after: "children-cursor" },
      { id: "one", after: "label-cursor" },
      { id: "one", after: "blocker-cursor" },
    ],
  );
});

await test("discovery rejects incomplete or unsafe facts", async () => {
  const first = child("one", 11);
  first.labels = page([], "repeat");
  for (const responses of [
    [
      initial([first]),
      { data: { node: { id: "one", labels: page([], "repeat") } } },
    ],
    [
      initial([
        {
          ...child("one", 11),
          blockedBy: page([issue("bad", 30, "CLOSED", null)]),
        },
      ]),
    ],
    [
      initial([
        {
          ...child("one", 11),
          repository: { id: "foreign", nameWithOwner: "elsewhere/repo" },
        },
      ]),
    ],
    [
      {
        ...initial([]),
        errors: [{ message: "partial data", path: ["repository"] }],
      },
    ],
    [initial([{ ...child("one", 11), labels: null }])],
  ]) {
    const script = tracker(responses);
    await assert.rejects(
      script.adapter.discoverParent("owner/repo", 10, "runner", "reserved"),
    );
  }
});

await test("discovery deduplicates repeated identities and keeps nullable lookup results", async () => {
  const repeated = child("one", 11);
  const first = initial([repeated], "next");
  first.data.repository.label =
    null as unknown as typeof first.data.repository.label;
  first.data.user = null as unknown as typeof first.data.user;
  const script = tracker([
    first,
    { data: { node: { id: "parent", subIssues: page([repeated]) } } },
  ]);
  const result = await script.adapter.discoverParent(
    "owner/repo",
    10,
    "runner",
    "reserved",
  );
  assert.equal(result.tickets.length, 1);
  assert.equal(result.reservationId, null);
  assert.equal(result.runnerId, null);
});
