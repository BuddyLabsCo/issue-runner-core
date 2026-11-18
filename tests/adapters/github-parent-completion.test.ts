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
function tracker(responses: unknown[]) {
  const calls: { query: string; variables: Record<string, unknown> }[] = [];
  const command: GitHubCommand = (_args, options) => {
    calls.push(JSON.parse(options.input!) as (typeof calls)[number]);
    assert.ok(responses.length, "unexpected request");
    return Promise.resolve(JSON.stringify(responses.shift()));
  };
  return { adapter: new GitHubTracker("token", command), calls };
}

await test("parent completion drains child pages in both scan and close confirmation", async () => {
  const completed = issue("parent", 10, "CLOSED", "COMPLETED");
  const first = issue("one", 11, "CLOSED", "NOT_PLANNED");
  const second = issue("two", 12, "CLOSED", "COMPLETED");
  const script = tracker([
    {
      data: {
        repository: {
          ...repo,
          issue: { ...issue("parent", 10), subIssues: page([first], "scan") },
        },
      },
    },
    { data: { node: { id: "parent", subIssues: page([second]) } } },
    {
      data: {
        closeIssue: {
          issue: { ...completed, subIssues: page([first], "confirm") },
        },
      },
    },
    { data: { node: { id: "parent", subIssues: page([second]) } } },
  ]);
  const scan = await script.adapter.readParentCompletion("owner/repo", 10);
  const confirmation = await script.adapter.closeParent(
    "owner/repo",
    scan.parent,
  );
  assert.deepEqual(
    scan.tickets.map((ticket) => ticket.number),
    [11, 12],
  );
  assert.deepEqual(
    confirmation.tickets.map((ticket) => ticket.number),
    [11, 12],
  );
  assert.equal(confirmation.parent.stateReason, "completed");
  assert.match(
    script.calls[2]!.query,
    /closeIssue\(input:\{issueId:\$id,stateReason:COMPLETED\}\)/u,
  );
  for (const call of script.calls)
    assert.doesNotMatch(call.query, /blockedBy|labels|assignees/u);
});

await test("parent close rejects incomplete, erroneous, or mismatched confirmation", async () => {
  const parent = {
    number: 10,
    id: "parent",
    repositoryId: "repo",
    state: "open" as const,
    stateReason: null,
  };
  const closed = issue("parent", 10, "CLOSED", "COMPLETED");
  for (const response of [
    { data: { closeIssue: null } },
    {
      data: { closeIssue: { issue: { ...closed, subIssues: page([]) } } },
      errors: [{ message: "partial" }],
    },
    {
      data: {
        closeIssue: { issue: { ...closed, id: "wrong", subIssues: page([]) } },
      },
    },
    {
      data: {
        closeIssue: {
          issue: {
            ...closed,
            repository: { ...repo, id: "wrong" },
            subIssues: page([]),
          },
        },
      },
    },
    {
      data: {
        closeIssue: {
          issue: {
            ...closed,
            subIssues: {
              nodes: [],
              pageInfo: { hasNextPage: true, endCursor: null },
            },
          },
        },
      },
    },
  ]) {
    await assert.rejects(
      tracker([response]).adapter.closeParent("owner/repo", parent),
    );
  }
});
