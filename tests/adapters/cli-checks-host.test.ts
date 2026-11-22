import assert from "node:assert/strict";
import test from "node:test";
import { GitHubCodeHost } from "../../src/adapters/github-code-host.ts";
import { ActionsRerunRejected } from "../../src/run/contracts.ts";

import {
  connection,
  createdAt,
  exact,
  head,
  publication,
  remote,
} from "../support/github-pr-fixture.ts";

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
  id: string,
  name: string,
  conclusion: string,
  startedAt: string,
  extra = {},
) {
  return {
    __typename: "CheckRun",
    id,
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
    id: `SC_${context}`,
    context,
    state,
    targetUrl,
    isRequired: true,
  };
}

await test("required Actions checks identify a repository-scoped run for the failed-jobs endpoint", async () => {
  const runId = "45019148280";
  const runPath = `/Owner/Repo/actions/runs/${runId}`;
  const actionsCheck = (name: string, resourcePath: string) =>
    checkRun(`CR_${name}`, name, "FAILURE", createdAt, {
      checkSuite: {
        workflowRun: {
          workflow: { name: "Build" },
          event: "push",
          resourcePath,
        },
      },
    });
  const page = pollPage(
    head,
    connection([
      actionsCheck("quality", `${runPath}/attempts/1`),
      actionsCheck("foreign", `/another/repo/actions/runs/${runId}`),
      statusContext("external", "FAILURE", `https://github.com${runPath}`),
    ]),
  );
  const requests: string[][] = [];
  const apiPath = `repos/${publication.repository}/actions/runs/${runId}`;
  const adapter = new GitHubCodeHost(
    "host-secret",
    (args, { input, token }) => {
      assert.equal(token, "host-secret");
      if (args[1] === "graphql") {
        assert.match(input ?? "", /workflowRun \{ event resourcePath/u);
        return Promise.resolve(JSON.stringify({ data: { repository: page } }));
      }
      requests.push(args);
      return Promise.resolve(
        args[1] === apiPath
          ? JSON.stringify({
              id: Number(runId),
              run_attempt: 2,
              status: "queued",
              conclusion: null,
            })
          : "HTTP/2.0 201 Created\r\n\r\n",
      );
    },
  );
  const { checks } = await adapter.observePullRequest({
    ...publication,
    number: exact.number,
  });
  assert.deepEqual(
    checks.map(({ name, actionsRunId }) => [name, actionsRunId]),
    [
      ["quality", runId],
      ["foreign", undefined],
      ["external", undefined],
    ],
  );
  const run = {
    repository: publication.repository,
    runId: checks[0]!.actionsRunId!,
  };
  assert.deepEqual(await adapter.observeActionsRun(run), {
    attempt: 2,
    status: "queued",
    conclusion: null,
  });
  await adapter.rerunFailedJobs(run);
  assert.deepEqual(requests, [
    ["api", apiPath],
    ["api", `${apiPath}/rerun-failed-jobs`, "--method", "POST", "--include"],
  ]);
});

await test("the Actions adapter distinguishes a definite HTTP rejection from an uncertain write", async () => {
  const run = { repository: publication.repository, runId: "45019148280" };
  for (const status of [403, 503]) {
    const adapter = new GitHubCodeHost(
      "host-secret",
      (_args, { allowedExitCodes }) => {
        assert.deepEqual(allowedExitCodes, [1]);
        return Promise.resolve(`HTTP/2.0 ${status} Error\r\n\r\n`);
      },
    );
    await assert.rejects(
      adapter.rerunFailedJobs(run),
      (error: unknown) =>
        error instanceof Error &&
        error.message.includes(`HTTP ${status}`) &&
        error instanceof ActionsRerunRejected === (status === 403),
    );
  }
});

await test("CI drains all context pages before deduplicating reruns and filtering required checks", async () => {
  const later = "2026-11-18T12:01:00Z";
  const newest = "2026-11-18T12:02:00Z";
  const pages = [
    connection(
      [
        checkRun("CR_failed_build", "build", "FAILURE", createdAt),
        checkRun("CR_old_optional", "optional", "FAILURE", createdAt),
        statusContext("build", "ERROR", "https://statuses.example/build"),
      ],
      10,
      "page-2",
    ),
    connection(
      [
        checkRun("CR_successful_build", "build", "SUCCESS", newest, {
          detailsUrl: "https://checks.example/build",
        }),
        checkRun("CR_new_optional", "optional", "FAILURE", newest, {
          isRequired: false,
        }),
        checkRun("CR_pull_request_build", "build", "NEUTRAL", later, {
          checkSuite: {
            workflowRun: { workflow: { name: "Build" }, event: "pull_request" },
          },
        }),
        checkRun("CR_tests_build", "build", "CANCELLED", later, {
          checkSuite: {
            workflowRun: { workflow: { name: "Tests" }, event: "push" },
          },
        }),
        checkRun("CR_running_test", "test", "SUCCESS", later, {
          status: "IN_PROGRESS",
        }),
        checkRun("CR_future_state", "new conclusion", "FUTURE_STATE", later),
        statusContext("ready", "SUCCESS", null),
      ],
      10,
    ),
  ];
  const cursors: (string | null)[] = [];
  const adapter = new GitHubCodeHost("host-secret", (args, { input }) => {
    assert.equal(args[1], "graphql");
    const { query, variables } = JSON.parse(input!) as {
      query: string;
      variables: { after: string | null; number: number };
    };
    assert.match(query, /contexts\(\s*first:\s*100,\s*after:\s*\$after\s*\)/u);
    for (const type of ["CheckRun", "StatusContext"]) {
      const fields = query.split(`... on ${type} {`)[1]?.split("}")[0];
      assert.match(fields ?? "", /\bid\b/u, type);
      assert.match(
        fields ?? "",
        /isRequired\(pullRequestNumber:\s*\$number\)/u,
        type,
      );
    }
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
      connection([statusContext("shared check", "FAILURE", "")], 2, "stale"),
    ),
    pollPage(
      newHead,
      connection([statusContext("unusable cursor", "ERROR", "")], 2),
    ),
    pollPage(
      newHead,
      connection([statusContext("shared check", "SUCCESS", null)]),
    ),
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
    { name: "shared check", state: "SUCCESS", bucket: "pass", link: "" },
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
        checkRun("CR_optional", "optional", "FAILURE", createdAt, {
          isRequired: false,
        }),
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

await test("CI rejects overlapping check-context pages even when the reported count is complete", async () => {
  const repeated = checkRun("CR_repeated", "build", "SUCCESS", createdAt);
  const replies = [
    pollPage(head, connection([repeated], 2, "next")),
    pollPage(head, connection([repeated], 2)),
  ];
  const adapter = new GitHubCodeHost("host-secret", () =>
    Promise.resolve(JSON.stringify({ data: { repository: replies.shift() } })),
  );
  await assert.rejects(
    adapter.observePullRequest({ ...publication, number: exact.number }),
    /check context.*(?:duplicate|repeated|inconsistent)|(?:duplicate|repeated|inconsistent).*check context/u,
  );
  assert.equal(replies.length, 0);
});

for (const malformed of [
  { mergeQueueEntry: { id: null } },
  { autoMergeRequest: { enabledAt: null } },
]) {
  await test(`CI rejects a present ${Object.keys(malformed)[0]} with incomplete evidence`, async () => {
    const page = pollPage(
      head,
      connection([statusContext("build", "SUCCESS", null)]),
    );
    const adapter = new GitHubCodeHost("host-secret", () =>
      Promise.resolve(
        JSON.stringify({
          data: {
            repository: {
              ...page,
              pullRequest: { ...page.pullRequest, ...malformed },
            },
          },
        }),
      ),
    );
    await assert.rejects(
      adapter.observePullRequest({ ...publication, number: exact.number }),
      /invalid Pull Request merge facts/u,
    );
  });
}
