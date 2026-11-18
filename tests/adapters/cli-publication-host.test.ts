/* eslint-disable @typescript-eslint/require-await -- Scripted external boundaries. */
import assert from "node:assert/strict";
import test from "node:test";
import { GitHubCodeHost } from "../../src/adapters/github-code-host.ts";
import { executeCli } from "../../src/cli.ts";
import { implementationCommand } from "../support/implementation-run.ts";
import { publicationRun } from "../support/publication-run.ts";

await test("publication uses direct composed observations and preserves multiline creation metadata", async (t) => {
  const fixture = await publicationRun(t);
  const operations: string[] = [];
  let created = false;
  fixture.dependencies.operator.pause = async (message) => {
    throw new Error(message);
  };
  const adapter = new GitHubCodeHost("host-secret", async (args, options) => {
    assert.equal(options.token, "host-secret");
    if (args[1] === "--method")
      return JSON.stringify({ default_branch: "default-branch" });
    if (args[1]?.includes("/git/ref/heads/")) {
      const saved = await fixture.snapshot();
      return JSON.stringify({
        object: { sha: fixture.publicationState.branches.get(saved.branch) },
      });
    }
    assert.deepEqual(args, ["api", "graphql", "--input", "-"]);
    const request = JSON.parse(options.input!) as {
      query: string;
      variables: Record<string, unknown>;
    };
    const saved = await fixture.snapshot();
    const branch = saved.branch;
    const head = fixture.publicationState.branches.get(branch);
    const record = {
      id: "pr-81",
      number: 81,
      url: "https://github.com/Owner/Repo/pull/81",
      headRefName: branch,
      baseRefName: "default-branch",
      headRefOid: head,
      headRepository: { nameWithOwner: "Owner/Repo" },
      state: "OPEN",
      isDraft: false,
      createdAt: "2026-01-01T00:00:00Z",
    };
    if (request.query.includes("query Poll(")) {
      operations.push("poll");
      return JSON.stringify({
        data: {
          repository: {
            id: "repo-id",
            nameWithOwner: "Owner/Repo",
            ref: { target: { oid: head } },
            pullRequest: {
              ...record,
              mergedAt: null,
              mergeable: "MERGEABLE",
              mergeStateStatus: "CLEAN",
              isInMergeQueue: false,
              isMergeQueueEnabled: false,
              autoMergeRequest: null,
              mergeQueueEntry: null,
              commits: {
                nodes: [{ commit: { oid: head, statusCheckRollup: null } }],
              },
            },
          },
        },
      });
    }
    if (request.query.includes("PrePush")) operations.push("branch");
    else if (request.query.includes("query Publication("))
      operations.push("observe");
    else if (request.query.includes("CreatePublication")) {
      operations.push("create");
      assert.deepEqual(request.variables.input, {
        repositoryId: "repo-id",
        baseRefName: "default-branch",
        headRefName: branch,
        title: saved.pr_title,
        body: "Implement the Issue.\n\nCloses #50",
        draft: false,
        maintainerCanModify: true,
      });
      created = true;
      return JSON.stringify({
        data: { createPullRequest: { pullRequest: record } },
      });
    } else assert.fail("unexpected GraphQL query");
    const page = {
      nodes: created ? [record] : [],
      totalCount: created ? 1 : 0,
      pageInfo: { hasNextPage: false, endCursor: null },
    };
    return JSON.stringify({
      data: {
        repository: {
          id: "repo-id",
          nameWithOwner: "Owner/Repo",
          ref: head ? { target: { oid: head } } : null,
          source: page,
          target: page,
        },
      },
    });
  });
  const result = await executeCli(
    [...implementationCommand, "--no-auto-merge"],
    { ...fixture.dependencies, codeHost: adapter },
  );
  assert.match(
    result.summary.tickets![0]!.detail,
    /CI-ready/u,
    JSON.stringify(result),
  );
  assert.deepEqual(operations, ["branch", "observe", "create", "poll"]);
  assert.equal(
    (await fixture.snapshot()).publication?.pullRequest?.id,
    "pr-81",
  );
});
