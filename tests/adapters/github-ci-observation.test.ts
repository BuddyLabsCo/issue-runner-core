/* eslint-disable @typescript-eslint/require-await -- Scripted GitHub boundary. */
import assert from "node:assert/strict";
import test from "node:test";
import { GitHubCodeHost } from "../../src/adapters/github-code-host.ts";

const sha = "a".repeat(40);
const pr = {
  id: "pr",
  number: 7,
  url: "https://github.com/owner/repo/pull/7",
  headRefName: "topic",
  baseRefName: "main",
  headRefOid: sha,
  headRepository: { nameWithOwner: "owner/repo" },
  state: "OPEN",
  isDraft: false,
  createdAt: "2026-01-01T00:00:00Z",
  mergedAt: null,
  mergeable: "MERGEABLE",
  mergeStateStatus: "CLEAN",
  isInMergeQueue: false,
  isMergeQueueEnabled: false,
  autoMergeRequest: null,
  mergeQueueEntry: null,
};
const context = (
  name: string,
  required: boolean,
  startedAt: string,
  conclusion: string,
) => ({
  __typename: "CheckRun",
  name,
  status: "COMPLETED",
  conclusion,
  startedAt,
  completedAt: startedAt,
  detailsUrl: null,
  isRequired: required,
  checkSuite: { workflowRun: { event: "push", workflow: { name: "CI" } } },
});
await test("CI observation drains pages and deduplicates before filtering required checks", async () => {
  let calls = 0;
  const host = new GitHubCodeHost("token", async () => {
    calls++;
    const nodes =
      calls === 1
        ? [context("build", true, "2026-01-01T00:00:00Z", "FAILURE")]
        : [
            context("build", false, "2026-01-02T00:00:00Z", "SUCCESS"),
            {
              __typename: "StatusContext",
              context: "build",
              state: "SUCCESS",
              targetUrl: null,
              createdAt: "2026-01-01T00:00:00Z",
              isRequired: true,
            },
          ];
    return JSON.stringify({
      data: {
        repository: {
          id: "repo",
          nameWithOwner: "owner/repo",
          ref: { target: { oid: sha } },
          pullRequest: {
            ...pr,
            commits: {
              nodes: [
                {
                  commit: {
                    oid: sha,
                    statusCheckRollup: {
                      contexts: {
                        nodes,
                        totalCount: 3,
                        pageInfo: {
                          hasNextPage: calls === 1,
                          endCursor: calls === 1 ? "next" : null,
                        },
                      },
                    },
                  },
                },
              ],
            },
          },
        },
      },
    });
  });
  const observation = await host.observePullRequest("owner/repo", "topic", 7);
  assert.equal(calls, 2);
  assert.deepEqual(observation.checks, [
    { name: "build", state: "SUCCESS", link: "", bucket: "pass" },
  ]);
});

await test("CI observation discards pages read across a head change", async () => {
  let calls = 0;
  const newHead = "b".repeat(40);
  const host = new GitHubCodeHost("token", async (_args, options) => {
    calls++;
    const { variables } = JSON.parse(options.input!) as {
      variables: { after: string | null };
    };
    if (calls === 3) assert.equal(variables.after, null);
    const head = calls === 1 ? sha : newHead;
    const contexts = {
      nodes: [],
      totalCount: calls === 1 ? 1 : 0,
      pageInfo: {
        hasNextPage: calls === 1,
        endCursor: calls === 1 ? "next" : null,
      },
    };
    return JSON.stringify({
      data: {
        repository: {
          id: "repo",
          nameWithOwner: "owner/repo",
          ref: { target: { oid: head } },
          pullRequest: {
            ...pr,
            headRefOid: head,
            commits: {
              nodes: [
                { commit: { oid: head, statusCheckRollup: { contexts } } },
              ],
            },
          },
        },
      },
    });
  });
  const observed = await host.observePullRequest("owner/repo", "topic", 7);
  assert.equal(calls, 3);
  assert.equal(observed.lastCommit, newHead);
  assert.deepEqual(observed.checks, []);
});

await test("CI observation rejects GraphQL errors instead of reporting no checks", async () => {
  const host = new GitHubCodeHost("token", async () =>
    JSON.stringify({
      data: { repository: null },
      errors: [{ message: "denied" }],
    }),
  );
  await assert.rejects(
    host.observePullRequest("owner/repo", "topic", 7),
    /GraphQL errors/u,
  );
});

await test("CI observation maps required states and ignores optional failures", async () => {
  const states = [
    "SUCCESS",
    "SKIPPED",
    "NEUTRAL",
    "ERROR",
    "FAILURE",
    "TIMED_OUT",
    "ACTION_REQUIRED",
    "CANCELLED",
    "STALE",
    "FUTURE",
  ];
  const nodes = states.map((state, index) => ({
    __typename: "StatusContext",
    context: `check-${index}`,
    state,
    targetUrl: index === 0 ? "https://example.com/check" : null,
    createdAt: "2026-01-01T00:00:00Z",
    isRequired: true,
  }));
  nodes.push({
    __typename: "StatusContext",
    context: "optional",
    state: "FAILURE",
    targetUrl: null,
    createdAt: "2026-01-01T00:00:00Z",
    isRequired: false,
  });
  const host = new GitHubCodeHost("token", async () =>
    JSON.stringify({
      data: {
        repository: {
          id: "repo",
          nameWithOwner: "owner/repo",
          ref: { target: { oid: sha } },
          pullRequest: {
            ...pr,
            commits: {
              nodes: [
                {
                  commit: {
                    oid: sha,
                    statusCheckRollup: {
                      contexts: {
                        nodes,
                        totalCount: nodes.length,
                        pageInfo: { hasNextPage: false, endCursor: null },
                      },
                    },
                  },
                },
              ],
            },
          },
        },
      },
    }),
  );
  const result = await host.observePullRequest("owner/repo", "topic", 7);
  assert.deepEqual(
    result.checks.map((check) => check.bucket),
    [
      "pass",
      "skipping",
      "skipping",
      "fail",
      "fail",
      "fail",
      "fail",
      "cancel",
      "pending",
      "pending",
    ],
  );
  assert.equal(result.checks[0]!.link, "https://example.com/check");
  assert.equal(result.checks[1]!.link, "");
});

await test("CI observation accepts a present last commit with no rollup", async () => {
  const host = new GitHubCodeHost("token", async () =>
    JSON.stringify({
      data: {
        repository: {
          id: "repo",
          nameWithOwner: "owner/repo",
          ref: null,
          pullRequest: {
            ...pr,
            state: "MERGED",
            mergedAt: "2026-01-01T00:00:00Z",
            commits: {
              nodes: [{ commit: { oid: sha, statusCheckRollup: null } }],
            },
          },
        },
      },
    }),
  );
  const result = await host.observePullRequest("owner/repo", "topic", 7);
  assert.deepEqual(result.checks, []);
  assert.equal(result.head, null);
  assert.equal(result.merge.merged, true);
});
