/* eslint-disable @typescript-eslint/require-await -- Scripted external boundaries. */
import assert from "node:assert/strict";
import test from "node:test";
import { inspect } from "node:util";
import { GitHubCodeHost } from "../../src/adapters/github-code-host.ts";
import {
  connection,
  exact,
  head,
  publication,
  repository,
} from "../support/github-pr-fixture.ts";

const input = { repository: publication.repository, number: 81, ticket: 50 };
const mergedAt = "2026-11-18T12:10:00Z";
const merged = {
  ...exact,
  state: "MERGED",
  mergedAt,
  mergeable: "UNKNOWN",
  mergeStateStatus: "UNKNOWN",
  isInMergeQueue: false,
  isMergeQueueEnabled: false,
  autoMergeRequest: null,
  mergeQueueEntry: null,
  mergeCommit: { oid: "b".repeat(40) },
};
const issue = {
  id: "I_50",
  number: 50,
  repository,
  state: "CLOSED",
  stateReason: "COMPLETED",
};

function delivery(pullRequest = merged, observedIssue: unknown = issue) {
  return {
    repository: {
      ...repository,
      defaultBranchRef: { name: "main" },
      pullRequest,
      issue: observedIssue,
    },
  };
}

for (const autoMerge of [false, true]) {
  await test(`GitHub sends the accepted head in the direct ${autoMerge ? "auto-merge" : "squash"} mutation`, async () => {
    const mutation = autoMerge
      ? "enablePullRequestAutoMerge"
      : "mergePullRequest";
    const host = new GitHubCodeHost("host-secret", async (args, options) => {
      assert.deepEqual(args, [
        "api",
        "graphql",
        "--method",
        "POST",
        "--input",
        "-",
      ]);
      assert.equal(options.token, "host-secret");
      const request = JSON.parse(options.input!) as {
        query: string;
        variables: object;
      };
      assert.ok(request.query.includes(`${mutation}(input: $input)`));
      assert.deepEqual(request.variables, {
        input: {
          pullRequestId: exact.id,
          expectedHeadOid: head,
          mergeMethod: "SQUASH",
        },
      });
      const pullRequest = autoMerge
        ? {
            ...merged,
            state: "OPEN",
            mergedAt: null,
            autoMergeRequest: { enabledAt: mergedAt },
          }
        : merged;
      return JSON.stringify({ data: { [mutation]: { pullRequest } } });
    });
    assert.deepEqual(
      await host.requestSquashMerge({
        pullRequest: exact,
        headSha: head,
        autoMerge,
      }),
      { outcome: "accepted" },
    );
  });
}

for (const [message, outcome] of [
  ["Pull Request cannot be cleanly created", "conflict"],
  ["Merge conflict in README", "conflict"],
  ["branch protection rule prevents merging", "rejected"],
  ["HTTP 503: service unavailable", "rejected"],
] as const) {
  await test(`GitHub classifies ${message} and retains the original cause`, async () => {
    const cause = new Error(message);
    const host = new GitHubCodeHost("host-secret", async () => {
      throw cause;
    });
    const result = await host.requestSquashMerge({
      pullRequest: exact,
      headSha: head,
      autoMerge: false,
    });
    assert.equal(result.outcome, outcome);
    assert.equal(result.error, cause);
  });
}

await test("delivery reads the exact merged PR with the complete Issue labels across pages", async () => {
  const cursors: (string | null)[] = [];
  const host = new GitHubCodeHost("host-secret", async (_args, options) => {
    const request = JSON.parse(options.input!) as {
      query: string;
      variables: { after: string | null };
    };
    assert.match(
      request.query,
      /pullRequest\s*\(\s*number\s*:\s*\$number\s*\)/u,
    );
    const issueSelection = request.query.split(
      /\bissue\s*\(\s*number\s*:\s*\$ticket\s*\)/u,
    )[1];
    assert.ok(issueSelection);
    assert.doesNotMatch(
      issueSelection,
      /\b(?:assignees|blockedBy|subIssues|label|user)\b/u,
    );
    const selection =
      /\blabels\s*\(([^)]*)\)\s*\{((?:[^{}]|\{[^{}]*\})*)\}/u.exec(
        issueSelection,
      );
    assert.ok(selection);
    assert.match(selection[1]!, /\bafter\s*:\s*\$after\b/u);
    assert.match(selection[1]!, /\bfirst\s*:\s*100\b/u);
    const fields = selection[2]!;
    const nodes = /\bnodes\s*\{([^}]*)\}/u.exec(fields)?.[1] ?? "";
    const pageInfo = /\bpageInfo\s*\{([^}]*)\}/u.exec(fields)?.[1] ?? "";
    assert.match(nodes, /\bid\b/u);
    assert.match(nodes, /\bname\b/u);
    assert.match(pageInfo, /\bhasNextPage\b/u);
    assert.match(pageInfo, /\bendCursor\b/u);
    assert.match(fields.replace(/\{[^}]*\}/gu, ""), /\btotalCount\b/u);
    assert.partialDeepStrictEqual(request.variables, {
      owner: "owner",
      name: "repo",
      number: 81,
      ticket: 50,
    });
    const { after } = request.variables;
    cursors.push(after);
    const labels =
      after === null
        ? connection([{ id: "L_1", name: "Docs" }], 2, "next")
        : connection([{ id: "L_2", name: "runner:reserved" }], 2);
    return JSON.stringify({ data: delivery(merged, { ...issue, labels }) });
  });
  const observed = await host.observeDelivery(input);
  assert.partialDeepStrictEqual(observed, {
    pullRequest: { id: exact.id, headSha: head, state: "merged" },
    issue: {
      id: issue.id,
      stateReason: "completed",
      labels: ["Docs", "runner:reserved"],
    },
  });
  assert.deepEqual(cursors, [null, "next"]);
});

for (const [observedIssue, message] of [
  [
    { ...issue, number: 51 },
    /unexpected Pull Request or Issue delivery identity/u,
  ],
  [{ ...issue, labels: connection([], 1) }, /incomplete Issue label pages/u],
] as const) {
  await test(`delivery rejects ${message.source}`, async () => {
    const host = new GitHubCodeHost("host-secret", async () =>
      JSON.stringify({ data: delivery(merged, observedIssue) }),
    );
    await assert.rejects(host.observeDelivery(input), message);
  });
}

await test("GraphQL field errors prevent delivery even with a merged PR and a completed Issue in the response", async () => {
  const credential = "test-delivery-credential";
  const path = ["repository", "issue", "labels"];
  const errors = [
    {
      message: "labels denied",
      path,
      extensions: { metadata: { [credential]: credential } },
    },
  ];
  const host = new GitHubCodeHost(credential, async () =>
    JSON.stringify({
      data: delivery(merged, { ...issue, labels: connection([]) }),
      errors,
    }),
  );
  await assert.rejects(host.observeDelivery(input), (error: unknown) => {
    assert.ok(error instanceof Error);
    assert.match(error.message, /labels denied/u);
    assert.ok(
      !inspect(error, { depth: null, showHidden: true }).includes(credential),
    );
    assert.partialDeepStrictEqual(error.cause, {
      response: { errors: [{ path }] },
      commandError: null,
    });
    return true;
  });
});
