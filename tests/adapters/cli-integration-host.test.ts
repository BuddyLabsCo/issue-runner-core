/* eslint-disable @typescript-eslint/require-await -- Scripted external boundaries. */
import assert from "node:assert/strict";
import test from "node:test";
import { GitHubCodeHost } from "../../src/adapters/github-code-host.ts";
import { GitHubTracker } from "../../src/adapters/github-tracker.ts";
import { integrationRun } from "../support/integration-run.ts";
import { implementationCommit } from "../support/implementation-run.ts";

await test("delivery observation includes the exact merged PR and completed Issue labels", async () => {
  const host = new GitHubCodeHost("token", async (_args, options) => {
    const payload = JSON.parse(options.input!) as {
      variables: Record<string, unknown>;
    };
    assert.equal(payload.variables.issue, 50);
    return JSON.stringify({
      data: {
        repository: {
          nameWithOwner: "owner/repo",
          pullRequest: {
            id: "PR_81",
            number: 81,
            url: "https://example.test/pr/81",
            headRefName: "ticket-50",
            baseRefName: "main",
            headRefOid: implementationCommit.sha,
            createdAt: "2026-10-30T00:00:00Z",
            state: "MERGED",
            mergedAt: "2026-10-31T00:00:00Z",
            mergeable: "MERGEABLE",
            mergeStateStatus: "CLEAN",
            isInMergeQueue: false,
            isMergeQueueEnabled: false,
            autoMergeRequest: null,
            mergeQueueEntry: null,
          },
          issue: {
            number: 50,
            state: "CLOSED",
            stateReason: "COMPLETED",
            labels: {
              nodes: [{ name: "Docs" }],
              totalCount: 1,
              pageInfo: { hasNextPage: false, endCursor: null },
            },
          },
        },
      },
    });
  });
  const result = await host.observeDelivery("owner/repo", 81, 50);
  assert.equal(result.pullRequest.merged, true);
  assert.deepEqual(result.ticket.labels, ["Docs"]);
});

await test("delivery observation accepts a reopened Issue as open", async () => {
  const host = new GitHubCodeHost("token", async () =>
    JSON.stringify({
      data: {
        repository: {
          nameWithOwner: "owner/repo",
          pullRequest: {
            id: "PR_81",
            number: 81,
            url: "https://example.test/pr/81",
            headRefName: "ticket-50",
            baseRefName: "main",
            headRefOid: implementationCommit.sha,
            createdAt: "2026-10-30T00:00:00Z",
            state: "MERGED",
            mergedAt: "2026-10-31T00:00:00Z",
            mergeable: "MERGEABLE",
            mergeStateStatus: "CLEAN",
            isInMergeQueue: false,
            isMergeQueueEnabled: false,
            autoMergeRequest: null,
            mergeQueueEntry: null,
          },
          issue: {
            number: 50,
            state: "OPEN",
            stateReason: "REOPENED",
            labels: {
              nodes: [],
              totalCount: 0,
              pageInfo: { hasNextPage: false, endCursor: null },
            },
          },
        },
      },
    }),
  );
  const result = await host.observeDelivery("owner/repo", 81, 50);
  assert.equal(result.ticket.state, "open");
  assert.equal(result.ticket.stateReason, null);
});

await test("direct squash mutation protects the accepted head", async () => {
  const host = new GitHubCodeHost("token", async (args, options) => {
    assert.deepEqual(args, ["api", "graphql", "--input", "-"]);
    const payload = JSON.parse(options.input!) as {
      query: string;
      variables: unknown;
    };
    assert.match(payload.query, /mergePullRequest/u);
    assert.deepEqual(payload.variables, {
      input: {
        pullRequestId: "PR_81",
        expectedHeadOid: implementationCommit.sha,
        mergeMethod: "SQUASH",
      },
    });
    return JSON.stringify({
      data: {
        mergePullRequest: {
          pullRequest: {
            id: "PR_81",
            number: 81,
            headRefOid: implementationCommit.sha,
            state: "MERGED",
            mergedAt: "2026-10-31T00:00:00Z",
          },
        },
      },
    });
  });
  assert.equal(
    (
      await host.requestSquashMerge({
        repository: "owner/repo",
        pullRequest: 81,
        pullRequestId: "PR_81",
        headSha: implementationCommit.sha,
        admin: false,
        queue: false,
      })
    ).outcome,
    "accepted",
  );
});

await test("required queue uses expected-head auto-merge and rejects a mismatched response", async () => {
  const host = new GitHubCodeHost("token", async (_args, options) => {
    const payload = JSON.parse(options.input!) as {
      query: string;
      variables: { input: Record<string, string> };
    };
    assert.match(payload.query, /enablePullRequestAutoMerge/u);
    assert.equal(
      payload.variables.input.expectedHeadOid,
      implementationCommit.sha,
    );
    return JSON.stringify({
      data: {
        enablePullRequestAutoMerge: {
          pullRequest: {
            id: "PR_81",
            number: 81,
            headRefOid: "c".repeat(40),
            state: "OPEN",
          },
        },
      },
    });
  });
  const result = await host.requestSquashMerge({
    repository: "owner/repo",
    pullRequest: 81,
    pullRequestId: "PR_81",
    headSha: implementationCommit.sha,
    admin: false,
    queue: true,
  });
  assert.equal(result.outcome, "rejected");
});

await test("GitHub integration uses squash, observed HEAD, admin policy, queue observation and completed closure", async (t) => {
  const fixture = await integrationRun(t);
  let queued = false;
  let merged = false;
  let requests = 0;
  const host = new GitHubCodeHost("host-secret", async (args, options) => {
    assert.equal(options.token, "host-secret");
    assert.deepEqual(args, ["api", "graphql", "--input", "-"]);
    const payload = JSON.parse(options.input!) as {
      query: string;
      variables: Record<string, unknown>;
    };
    if (payload.query.includes("mutation")) {
      assert.deepEqual(payload.variables.input, {
        pullRequestId: "pr-81",
        expectedHeadOid: implementationCommit.sha,
        mergeMethod: "SQUASH",
      });
      requests++;
      queued = true;
      return JSON.stringify({
        data: {
          mergePullRequest: {
            pullRequest: {
              id: "pr-81",
              number: 81,
              headRefOid: implementationCommit.sha,
              state: "OPEN",
            },
          },
        },
      });
    }
    const pr = fixture.publicationState.pullRequests[0]!;
    const second = payload.variables.after === "next";
    return JSON.stringify({
      data: {
        repository: {
          nameWithOwner: "owner/repo",
          pullRequest: {
            id: pr.id,
            number: pr.number,
            url: pr.url,
            headRefName: pr.branch,
            baseRefName: pr.targetBranch,
            headRefOid: pr.headSha,
            createdAt: pr.createdAt,
            state: merged ? "MERGED" : "OPEN",
            mergedAt: merged ? "2026-10-31T00:00:00Z" : null,
            mergeable: "MERGEABLE",
            mergeStateStatus: "CLEAN",
            isInMergeQueue: queued,
            isMergeQueueEnabled: false,
            autoMergeRequest: null,
            mergeQueueEntry: queued ? { id: "queue-entry" } : null,
          },
          issue: {
            number: 50,
            state: fixture.state.ticket.state.toUpperCase(),
            stateReason:
              fixture.state.ticket.stateReason?.toUpperCase() ?? null,
            labels: {
              nodes: second
                ? [{ name: "last-label" }]
                : Array.from({ length: 100 }, (_, i) => ({
                    name: `label-${i}`,
                  })),
              totalCount: 101,
              pageInfo: {
                hasNextPage: !second,
                endCursor: second ? null : "next",
              },
            },
          },
        },
      },
    });
  });
  const tracker = new GitHubTracker("tracker-secret", async (args, options) => {
    assert.equal(options.token, "tracker-secret");
    assert.equal(merged, true);
    if (args[0] === "api") {
      if (args[3] === "repos/owner/repo/issues/50")
        return JSON.stringify({
          number: 50,
          state: fixture.state.ticket.state,
          state_reason: fixture.state.ticket.stateReason,
        });
      assert.equal(args[3], "repos/owner/repo/issues/50/labels");
      return JSON.stringify(
        args.includes("page=1")
          ? Array.from({ length: 100 }, (_, index) => ({
              name: `label-${index}`,
            }))
          : [{ name: "last-label" }],
      );
    }
    assert.deepEqual(args, [
      "issue",
      "close",
      "50",
      "--repo",
      "owner/repo",
      "--reason",
      "completed",
    ]);
    fixture.state.ticket.state = "closed";
    fixture.state.ticket.stateReason = "completed";
    return "";
  });
  Object.assign(fixture.dependencies.codeHost, {
    observeDelivery: host.observeDelivery.bind(host),
    requestSquashMerge: host.requestSquashMerge.bind(host),
  });
  Object.assign(fixture.dependencies.tracker, {
    closeTicket: tracker.closeTicket.bind(tracker),
    getDeliveryTicket: tracker.getDeliveryTicket.bind(tracker),
  });
  fixture.state.onSleep = async () => {
    if (queued) merged = true;
  };
  const result = await fixture.run();
  assert.equal(result.summary.outcome, "succeeded", JSON.stringify(result));
  assert.equal(requests, 1);
  assert.equal(
    (await fixture.snapshot()).publication?.deliveryLabels?.at(-1),
    "last-label",
  );
  assert.equal(
    (await fixture.snapshot()).publication?.deliveryLabels?.length,
    101,
  );
  assert.equal(
    (await fixture.snapshot()).publication?.closure?.stateReason,
    "completed",
  );
});

for (const [message, outcome] of [
  ["Pull Request cannot be cleanly created", "conflict"],
  ["Merge conflict in README", "conflict"],
  ["branch protection rule prevents merging", "rejected"],
  ["HTTP 503: service unavailable", "rejected"],
] as const) {
  await test(`GitHub classifies ${message} and retains the original cause`, async () => {
    const cause = new Error(message);
    const host = new GitHubCodeHost("token", async (args) => {
      assert.deepEqual(args, ["api", "graphql", "--input", "-"]);
      throw cause;
    });
    const result = await host.requestSquashMerge({
      repository: "owner/repo",
      pullRequest: 81,
      pullRequestId: "PR_81",
      headSha: implementationCommit.sha,
      admin: true,
      queue: false,
    });
    assert.equal(result.outcome, outcome);
    assert.equal(result.error, cause);
  });
}

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
