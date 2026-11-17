/* eslint-disable @typescript-eslint/require-await -- Scripted GraphQL boundary. */
import assert from "node:assert/strict";
import test from "node:test";
import { GitHubClient } from "../../src/adapters/github-client.ts";
import { observeParent } from "../../src/adapters/github-parent-observation.ts";

const repo = { id: "repo", nameWithOwner: "owner/repo" };
const issue = (id: string, number: number) => ({
  id,
  number,
  state: "OPEN",
  stateReason: null,
  repository: repo,
});
const connection = (nodes: unknown[], cursor: string | null = null) => ({
  nodes,
  pageInfo: { hasNextPage: cursor !== null, endCursor: cursor },
});
const child = (id: string, number: number) => ({
  ...issue(id, number),
  labels: connection([{ id: "l1", name: "ready" }], "labels-next"),
  assignees: connection([], "assignees-next"),
  blockedBy: connection([], "blockers-next"),
});

await test("parent observation drains independent cursors before returning facts", async () => {
  const calls: string[] = [];
  const client = new GitHubClient("token", async (_args, options) => {
    const input = JSON.parse(options.input!) as {
      query: string;
      variables: { id?: string; after?: string };
    };
    const { id, after } = input.variables;
    calls.push(`${id ?? "root"}:${after ?? "first"}`);
    if (!id)
      return JSON.stringify({
        data: {
          repository: {
            ...repo,
            issue: {
              ...child("parent", 1),
              subIssues: connection([child("child", 2)], "children-next"),
            },
          },
        },
      });
    const field =
      after === "children-next"
        ? "subIssues"
        : after === "labels-next"
          ? "labels"
          : after === "assignees-next"
            ? "assignees"
            : "blockedBy";
    const nodes =
      field === "labels"
        ? [{ id: "l2", name: "reserved" }]
        : field === "assignees"
          ? [{ id: "a", login: "runner" }]
          : field === "blockedBy"
            ? [{ ...issue("b", 3), state: "CLOSED", stateReason: "COMPLETED" }]
            : [];
    return JSON.stringify({
      data: { node: { id, [field]: connection(nodes) } },
    });
  });
  const result = await observeParent(client, "owner/repo", 1);
  assert.deepEqual(result.parent.labels, ["ready", "reserved"]);
  assert.deepEqual(result.parent.assignees, ["runner"]);
  assert.equal(result.parent.blockers?.[0]?.state, "closed");
  assert.deepEqual(result.tickets[0]?.labels, ["ready", "reserved"]);
  assert.deepEqual(result.tickets[0]?.assignees, ["runner"]);
  assert.equal(result.tickets[0]?.blockers[0]?.state, "closed");
  assert.deepEqual(
    new Set(calls),
    new Set([
      "root:first",
      "parent:children-next",
      "parent:labels-next",
      "parent:assignees-next",
      "parent:blockers-next",
      "child:labels-next",
      "child:assignees-next",
      "child:blockers-next",
    ]),
  );
});

await test("parent observation rejects incomplete responses and repeated cursors", async () => {
  for (const broken of ["errors", "cursor"] as const) {
    const client = new GitHubClient("token", async (_args, options) => {
      const { variables } = JSON.parse(options.input!) as {
        variables: { id?: string };
      };
      if (broken === "errors")
        return JSON.stringify({ data: {}, errors: [{ message: "denied" }] });
      if (!variables.id)
        return JSON.stringify({
          data: {
            repository: {
              ...repo,
              issue: {
                ...child("parent", 1),
                subIssues: connection([], "again"),
              },
            },
          },
        });
      return JSON.stringify({
        data: { node: { id: "parent", subIssues: connection([], "again") } },
      });
    });
    await assert.rejects(
      observeParent(client, "owner/repo", 1),
      /incomplete|non-advancing/u,
    );
  }
});

await test("parent observation accepts canonical repository casing for empty and populated parents", async () => {
  for (const nodes of [[], [child("child", 2)]]) {
    const client = new GitHubClient("token", async (_args, options) => {
      const { variables } = JSON.parse(options.input!) as {
        variables: { id?: string; after?: string };
      };
      if (!variables.id)
        return JSON.stringify({
          data: {
            repository: {
              ...repo,
              issue: { ...child("parent", 1), subIssues: connection(nodes) },
            },
          },
        });
      const field =
        variables.after === "labels-next"
          ? "labels"
          : variables.after === "assignees-next"
            ? "assignees"
            : "blockedBy";
      return JSON.stringify({
        data: { node: { id: variables.id, [field]: connection([]) } },
      });
    });
    const result = await observeParent(client, "OWNER/REPO", 1);
    assert.equal(result.tickets.length, nodes.length);
  }
});
