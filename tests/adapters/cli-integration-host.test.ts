/* eslint-disable @typescript-eslint/require-await -- Scripted external boundaries. */
import assert from "node:assert/strict";
import test from "node:test";
import { GitHubCodeHost } from "../../src/adapters/github-code-host.ts";
import { integrationRun } from "../support/integration-run.ts";
import { implementationCommit } from "../support/implementation-run.ts";

for (const [queue, admin, mutation] of [
  [false, false, "mergePullRequest"],
  [true, false, "enablePullRequestAutoMerge"],
  [true, true, "mergePullRequest"],
] as const) {
  await test(`GitHub dispatches ${mutation} with the accepted head`, async () => {
    const host = new GitHubCodeHost("host-secret", async (args, options) => {
      assert.deepEqual(args, ["api", "graphql", "--input", "-"]);
      assert.equal(options.token, "host-secret");
      const request = JSON.parse(options.input!) as {
        query: string;
        variables: unknown;
      };
      assert.match(request.query, new RegExp(mutation, "u"));
      assert.deepEqual(request.variables, {
        input: {
          pullRequestId: "PR_81",
          expectedHeadOid: implementationCommit.sha,
          mergeMethod: "SQUASH",
        },
      });
      return JSON.stringify({
        data: {
          [mutation]: {
            pullRequest: {
              id: "PR_81",
              number: 81,
              headRefOid: implementationCommit.sha,
              state: "OPEN",
            },
          },
        },
      });
    });
    assert.deepEqual(
      await host.requestSquashMerge({
        repository: "owner/repo",
        pullRequest: 81,
        pullRequestId: "PR_81",
        headSha: implementationCommit.sha,
        admin,
        queue,
      }),
      { outcome: "accepted" },
    );
  });
}

await test("a partial GraphQL merge result cannot establish success", async () => {
  const host = new GitHubCodeHost("token", async () =>
    JSON.stringify({
      data: { mergePullRequest: null },
      errors: [{ message: "permission denied" }],
    }),
  );
  const result = await host.requestSquashMerge({
    repository: "owner/repo",
    pullRequest: 81,
    pullRequestId: "PR_81",
    headSha: implementationCommit.sha,
    admin: false,
    queue: false,
  });
  assert.equal(result.outcome, "rejected");
});

await test("an invalid GitHub merge observation cannot close the Issue or earn delivery credit", async (t) => {
  const fixture = await integrationRun(t);
  const host = new GitHubCodeHost("token", async () =>
    JSON.stringify({
      data: { repository: { pullRequest: { state: "MERGED" } } },
    }),
  );
  fixture.dependencies.codeHost.getPullRequest = host.getPullRequest.bind(host);
  fixture.dependencies.operator.pause = async (message) => {
    assert.match(message, /invalid Pull Request state/u);
    return "q";
  };
  assert.equal((await fixture.run()).summary.outcome, "cancelled");
  assert.equal(fixture.integrationState.requests.length, 0);
  assert.equal(fixture.integrationState.closures, 0);
});

await test("combined delivery observation drains labels and retains the exact merged PR head", async () => {
  const calls: unknown[] = [];
  const host = new GitHubCodeHost("token", async (_args, options) => {
    const { variables } = JSON.parse(options.input!) as {
      variables: { after: string | null };
    };
    calls.push(variables.after);
    const first = variables.after === null;
    return JSON.stringify({
      data: {
        repository: {
          id: "REPO_1",
          nameWithOwner: "owner/repo",
          pullRequest: {
            id: "PR_81",
            number: 81,
            url: "https://github.com/owner/repo/pull/81",
            headRefName: "work",
            baseRefName: "main",
            headRefOid: implementationCommit.sha,
            state: "MERGED",
            isDraft: false,
            createdAt: "2026-10-30T00:00:00Z",
            mergedAt: "2026-10-31T00:00:00Z",
            mergeable: "UNKNOWN",
            mergeStateStatus: "UNKNOWN",
            isInMergeQueue: false,
            isMergeQueueEnabled: false,
            autoMergeRequest: null,
            mergeQueueEntry: null,
          },
          issue: {
            id: "ISSUE_50",
            number: 50,
            state: "CLOSED",
            stateReason: "COMPLETED",
            repository: { id: "REPO_1", nameWithOwner: "owner/repo" },
            labels: {
              totalCount: 2,
              nodes: [{ id: first ? "L1" : "L2", name: first ? "one" : "two" }],
              pageInfo: {
                hasNextPage: first,
                endCursor: first ? "cursor" : null,
              },
            },
          },
        },
      },
    });
  });
  const result = await host.observeDelivery({
    repository: "owner/repo",
    pullRequest: 81,
    ticket: 50,
  });
  assert.deepEqual(calls, [null, "cursor"]);
  assert.equal(result.pullRequest.headSha, implementationCommit.sha);
  assert.equal(result.state.merged, true);
  assert.deepEqual(result.ticket.labels, ["one", "two"]);
  assert.equal(result.ticket.stateReason, "completed");
});

await test("incomplete delivery responses cannot confirm a merge", async () => {
  const host = new GitHubCodeHost("token", async () =>
    JSON.stringify({
      data: { repository: null },
      errors: [{ message: "inaccessible" }],
    }),
  );
  await assert.rejects(
    host.observeDelivery({
      repository: "owner/repo",
      pullRequest: 81,
      ticket: 50,
    }),
    /incomplete delivery/u,
  );
});
