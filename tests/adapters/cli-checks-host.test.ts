import assert from "node:assert/strict";
import test from "node:test";
import { GitHubCodeHost } from "../../src/adapters/github-code-host.ts";

const repository = { id: "R_repo", nameWithOwner: "Owner/Repo" };
const createdAt = "2026-11-18T12:00:00Z";

function connection(
  nodes: unknown[],
  totalCount = nodes.length,
  next: string | null = null,
) {
  return {
    nodes,
    totalCount,
    pageInfo: { hasNextPage: next !== null, endCursor: next },
  };
}

const publication = {
  repository: "owner/repo",
  branch: "runner/issue",
  targetBranch: "main",
};
const head = "a".repeat(40);
const remote = {
  ...repository,
  ref: { name: publication.branch, target: { oid: head } },
};
const exact = {
  id: "PR_exact",
  number: 81,
  url: "https://github.com/Owner/Repo/pull/81",
  headRefName: publication.branch,
  baseRefName: publication.targetBranch,
  headRefOid: head,
  repository,
  headRepository: repository,
  state: "OPEN",
  isDraft: false,
  createdAt,
};

function pollPage(sha: string, contexts: ReturnType<typeof connection> | null) {
  return {
    ...remote,
    ref: { name: publication.branch, target: { oid: sha } },
    pullRequest: {
      ...exact,
      headRefOid: sha,
      mergedAt: null,
      mergeable: "MERGEABLE",
      mergeStateStatus: "BLOCKED",
      isInMergeQueue: true,
      isMergeQueueEnabled: true,
      autoMergeRequest: { enabledAt: createdAt },
      mergeQueueEntry: { id: "queue-entry" },
      commits: {
        nodes: [
          {
            commit: {
              oid: sha,
              statusCheckRollup: contexts === null ? null : { contexts },
            },
          },
        ],
      },
    },
  };
}

function checkRun(
  name: string,
  conclusion: string,
  startedAt: string,
  extra = {},
) {
  return {
    __typename: "CheckRun",
    name,
    status: "COMPLETED",
    conclusion,
    startedAt,
    detailsUrl: null,
    isRequired: true,
    checkSuite: { workflowRun: { workflow: { name: "Build" }, event: "push" } },
    ...extra,
  };
}

function statusContext(
  context: string,
  state: string,
  targetUrl: string | null,
) {
  return {
    __typename: "StatusContext",
    context,
    state,
    targetUrl,
    isRequired: true,
  };
}

await test("CI drains all context pages before deduplicating reruns and filtering required checks", async () => {
  const later = "2026-11-18T12:01:00Z";
  const newest = "2026-11-18T12:02:00Z";
  const pages = [
    connection(
      [
        checkRun("build", "FAILURE", createdAt),
        checkRun("optional", "FAILURE", createdAt),
        statusContext("build", "ERROR", "https://statuses.example/build"),
      ],
      10,
      "page-2",
    ),
    connection(
      [
        checkRun("build", "SUCCESS", newest, {
          detailsUrl: "https://checks.example/build",
        }),
        checkRun("optional", "FAILURE", newest, { isRequired: false }),
        checkRun("build", "NEUTRAL", later, {
          checkSuite: {
            workflowRun: { workflow: { name: "Build" }, event: "pull_request" },
          },
        }),
        checkRun("build", "CANCELLED", later, {
          checkSuite: {
            workflowRun: { workflow: { name: "Tests" }, event: "push" },
          },
        }),
        checkRun("test", "SUCCESS", later, { status: "IN_PROGRESS" }),
        checkRun("new conclusion", "FUTURE_STATE", later),
        statusContext("ready", "SUCCESS", null),
      ],
      10,
    ),
  ];
  const cursors: (string | null)[] = [];
  const adapter = new GitHubCodeHost("host-secret", (args, { input }) => {
    assert.equal(args[1], "graphql");
    const { variables } = JSON.parse(input!) as {
      variables: { after: string | null; number: number };
    };
    assert.equal(variables.number, exact.number);
    cursors.push(variables.after);
    return Promise.resolve(
      JSON.stringify({
        data: { repository: pollPage(head, pages.shift()!) },
      }),
    );
  });
  const result = await adapter.observePullRequest({
    ...publication,
    number: exact.number,
  });
  assert.deepEqual(cursors, [null, "page-2"]);
  assert.deepEqual(result.checks, [
    {
      name: "build",
      state: "SUCCESS",
      bucket: "pass",
      link: "https://checks.example/build",
    },
    { name: "build", state: "NEUTRAL", bucket: "skipping", link: "" },
    { name: "build", state: "CANCELLED", bucket: "cancel", link: "" },
    { name: "test", state: "IN_PROGRESS", bucket: "pending", link: "" },
    {
      name: "new conclusion",
      state: "FUTURE_STATE",
      bucket: "pending",
      link: "",
    },
    {
      name: "build",
      state: "ERROR",
      bucket: "fail",
      link: "https://statuses.example/build",
    },
    { name: "ready", state: "SUCCESS", bucket: "pass", link: "" },
  ]);
  assert.deepEqual(result.merge, {
    headSha: head,
    createdAt,
    merged: false,
    mergeFailure: null,
    mergeable: "mergeable",
    mergeStateStatus: "BLOCKED",
    mergeRequested: true,
    isInMergeQueue: true,
    isMergeQueueEnabled: true,
    autoMergeEnabledAt: createdAt,
    mergeQueueEntryId: "queue-entry",
  });
});

await test("CI restarts context pagination from the first page after the Pull Request head changes", async () => {
  const newHead = "b".repeat(40);
  const replies = [
    pollPage(
      head,
      connection([statusContext("stale failure", "FAILURE", "")], 2, "stale"),
    ),
    pollPage(
      newHead,
      connection([statusContext("unusable cursor", "ERROR", "")], 2),
    ),
    pollPage(newHead, connection([statusContext("new head", "SUCCESS", null)])),
  ];
  const cursors: (string | null)[] = [];
  const adapter = new GitHubCodeHost("host-secret", (_args, { input }) => {
    const { variables } = JSON.parse(input!) as {
      variables: { after: string | null };
    };
    cursors.push(variables.after);
    return Promise.resolve(
      JSON.stringify({ data: { repository: replies.shift() } }),
    );
  });
  const result = await adapter.observePullRequest({
    ...publication,
    number: exact.number,
  });
  assert.deepEqual(cursors, [null, "stale", null]);
  assert.equal(result.lastCommitSha, newHead);
  assert.deepEqual(result.checks, [
    { name: "new head", state: "SUCCESS", bucket: "pass", link: "" },
  ]);
});

await test("CI distinguishes empty required checks from missing or errored GitHub evidence", async () => {
  const valid = pollPage(head, null);
  for (const reply of [
    { data: { repository: { ...valid, pullRequest: null } } },
    {
      data: {
        repository: {
          ...valid,
          pullRequest: { ...valid.pullRequest, commits: { nodes: [] } },
        },
      },
    },
    {
      data: {
        repository: {
          ...valid,
          pullRequest: { ...valid.pullRequest, isMergeQueueEnabled: undefined },
        },
      },
    },
    {
      data: { repository: valid },
      errors: [{ message: "check contexts inaccessible" }],
    },
    { data: { repository: pollPage(head, connection([], 1)) } },
  ]) {
    const adapter = new GitHubCodeHost("host-secret", () =>
      Promise.resolve(JSON.stringify(reply)),
    );
    await assert.rejects(
      adapter.observePullRequest({ ...publication, number: exact.number }),
    );
  }
  for (const validPage of [
    valid,
    pollPage(head, connection([])),
    pollPage(
      head,
      connection([
        checkRun("optional", "FAILURE", createdAt, { isRequired: false }),
      ]),
    ),
  ]) {
    const adapter = new GitHubCodeHost("host-secret", () =>
      Promise.resolve(JSON.stringify({ data: { repository: validPage } })),
    );
    assert.deepEqual(
      (
        await adapter.observePullRequest({
          ...publication,
          number: exact.number,
        })
      ).checks,
      [],
    );
  }
});
