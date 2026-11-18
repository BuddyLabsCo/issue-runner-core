/* eslint-disable @typescript-eslint/require-await -- Scripted external boundaries. */
import assert from "node:assert/strict";
import test from "node:test";
import { GitHubCodeHost } from "../../src/adapters/github-code-host.ts";

const sha = "a".repeat(40);
const candidate = (id: string, branch: string, repository = "Owner/Repo") => ({
  id,
  number: Number(id),
  url: `https://github.com/Owner/Repo/pull/${id}`,
  headRefName: branch,
  baseRefName: "main",
  headRefOid: sha,
  headRepository: { nameWithOwner: repository },
  state: "CLOSED",
  isDraft: false,
  createdAt: "2026-01-01T00:00:00Z",
});
const page = (
  nodes: unknown[],
  totalCount: number,
  endCursor: string | null = null,
) => ({
  nodes,
  totalCount,
  pageInfo: { hasNextPage: endCursor !== null, endCursor },
});

await test("publication independently pages both candidate sets and deduplicates their union", async () => {
  const variables: Record<string, unknown>[] = [];
  const host = new GitHubCodeHost("token", async (_args, options) => {
    const request = JSON.parse(options.input!) as {
      variables: Record<string, unknown>;
    };
    variables.push(request.variables);
    const first = variables.length === 1;
    const source = first
      ? page([candidate("1", "topic")], 2, "source-next")
      : page([candidate("2", "topic", "fork/repo")], 2);
    const target = first
      ? page([candidate("1", "topic")], 2, "target-next")
      : page([candidate("3", "other")], 2);
    return JSON.stringify({
      data: {
        repository: {
          id: "repo",
          nameWithOwner: "Owner/Repo",
          ref: { target: { oid: sha } },
          source,
          target,
        },
      },
    });
  });
  const result = await host.observePublication("owner/repo", "topic", "main");
  assert.deepEqual(
    result.candidates.map((pr) => pr.id),
    ["1", "3"],
  );
  assert.equal(result.candidates[0]?.state, "closed");
  assert.equal(variables[1]?.headAfter, "source-next");
  assert.equal(variables[1]?.baseAfter, "target-next");
});

for (const failure of ["errors", "truncated", "missing-repository"] as const) {
  await test(`publication rejects ${failure} observations`, async () => {
    const host = new GitHubCodeHost("token", async () =>
      JSON.stringify(
        failure === "errors"
          ? { data: { repository: null }, errors: [{ message: "partial" }] }
          : {
              data: {
                repository:
                  failure === "missing-repository"
                    ? null
                    : {
                        id: "repo",
                        nameWithOwner: "Owner/Repo",
                        ref: null,
                        source: page([], 1),
                        target: page([], 0),
                      },
              },
            },
      ),
    );
    await assert.rejects(
      host.observePublication("owner/repo", "topic", "main"),
    );
  });
}

await test("publication rejects a head change while candidate pages are read", async () => {
  let calls = 0;
  const host = new GitHubCodeHost("token", async () => {
    calls++;
    return JSON.stringify({
      data: {
        repository: {
          id: "repo",
          nameWithOwner: "Owner/Repo",
          ref: { target: { oid: calls === 1 ? sha : "b".repeat(40) } },
          source:
            calls === 1
              ? page([], 1, "next")
              : page([candidate("1", "topic")], 1),
          target: page([], 0),
        },
      },
    });
  });
  await assert.rejects(
    host.observePublication("owner/repo", "topic", "main"),
    /changed during pagination/u,
  );
});
