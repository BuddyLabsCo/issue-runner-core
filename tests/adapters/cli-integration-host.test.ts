/* eslint-disable @typescript-eslint/require-await -- Scripted external boundaries. */
import assert from "node:assert/strict";
import test from "node:test";
import { inspect } from "node:util";
import { GitHubCodeHost } from "../../src/adapters/github-code-host.ts";
import { GitHubTracker } from "../../src/adapters/github-tracker.ts";
import { integrationRun } from "../support/integration-run.ts";
import { implementationCommit } from "../support/implementation-run.ts";
import {
  connection,
  issue,
  repository,
} from "../support/github-parent-discovery.ts";

await test("GitHub integration uses squash, observed HEAD, admin policy, queue observation and completed closure", async (t) => {
  const fixture = await integrationRun(t);
  let queued = false;
  let merged = false;
  let requests = 0;
  const deliveryReads: string[] = [];
  const firstLabel = { id: "docs-upper", name: "Docs" };
  const secondLabel = { id: "docs-lower", name: "docs" };
  const host = new GitHubCodeHost("host-secret", async (args, options) => {
    assert.equal(options.token, "host-secret");
    if (args[0] === "pr") {
      assert.deepEqual(args, [
        "pr",
        "merge",
        "81",
        "--repo",
        "owner/repo",
        "--squash",
        "--match-head-commit",
        implementationCommit.sha,
      ]);
      requests++;
      queued = true;
      return "";
    }
    assert.deepEqual(args, [
      "api",
      "graphql",
      "--method",
      "POST",
      "--input",
      "-",
    ]);
    assert.ok(options.input);
    assert.partialDeepStrictEqual(JSON.parse(options.input), {
      variables: { owner: "owner", name: "repo", number: 81 },
    });
    return JSON.stringify({
      data: {
        repository: {
          pullRequest: {
            headRefOid: implementationCommit.sha,
            createdAt: "2026-10-30T00:00:00Z",
            state: merged ? "MERGED" : "OPEN",
            mergedAt: merged ? "2026-10-31T00:00:00Z" : null,
            mergeable: "MERGEABLE",
            autoMergeRequest: null,
            mergeQueueEntry: queued ? { id: "queue-entry" } : null,
          },
        },
      },
    });
  });
  const tracker = new GitHubTracker("host-secret", async (args, options) => {
    assert.equal(options.token, "host-secret");
    assert.equal(merged, true);
    if (args[0] === "api") {
      assert.equal(args[1], "graphql");
      const { query, variables } = JSON.parse(options.input!) as {
        query: string;
        variables: Record<string, unknown>;
      };
      assert.match(query, /\blabels\b/u);
      assert.doesNotMatch(
        query,
        /\b(?:assignees|blockedBy|subIssues|label|user)\b/u,
      );
      if (variables.after !== undefined) {
        assert.deepEqual(variables, { owner: "issue-50", after: "labels" });
        deliveryReads.push("labels");
        return JSON.stringify({
          data: {
            node: { id: "issue-50", labels: connection([secondLabel], 2) },
          },
        });
      }
      assert.deepEqual(variables, { owner: "owner", name: "repo", number: 50 });
      const closed = fixture.state.ticket.state === "closed";
      deliveryReads.push(closed ? "closed" : "open");
      return JSON.stringify({
        data: {
          repository: {
            ...repository,
            issue: issue(50, {
              state: closed ? "CLOSED" : "OPEN",
              stateReason: closed ? "COMPLETED" : null,
              labels: closed
                ? connection([firstLabel], 2, "labels", true)
                : connection([]),
            }),
          },
        },
      });
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
  fixture.dependencies.codeHost.getPullRequest = host.getPullRequest.bind(host);
  Object.assign(fixture.dependencies.codeHost, {
    requestSquashMerge: host.requestSquashMerge.bind(host),
  });
  Object.assign(fixture.dependencies.tracker, {
    closeTicket: tracker.closeTicket.bind(tracker),
    readIssueDelivery: tracker.readIssueDelivery.bind(tracker),
  });
  fixture.state.onSleep = async () => {
    if (queued) merged = true;
  };
  const result = await fixture.run();
  assert.equal(result.summary.outcome, "succeeded", JSON.stringify(result));
  assert.equal(requests, 1);
  assert.deepEqual(deliveryReads, ["open", "closed", "labels"]);
  assert.deepEqual((await fixture.snapshot()).publication?.deliveryLabels, [
    "Docs",
    "docs",
  ]);
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
      assert.ok(args.includes("--admin"));
      throw cause;
    });
    const result = await host.requestSquashMerge({
      repository: "owner/repo",
      pullRequest: 81,
      headSha: implementationCommit.sha,
      admin: true,
    });
    assert.equal(result.outcome, outcome);
    assert.equal(result.error, cause);
  });
}

await test("GraphQL field errors prevent a Pull Request observation from confirming delivery", async () => {
  const credential = "fixture-credential";
  const path = ["repository", "pullRequest", "state"];
  const errors = [
    {
      message: "state denied",
      path,
      extensions: { metadata: { [credential]: credential } },
    },
  ];
  const host = new GitHubCodeHost(credential, async () =>
    JSON.stringify({
      data: {
        repository: {
          pullRequest: {
            headRefOid: implementationCommit.sha,
            createdAt: "2026-10-30T00:00:00Z",
            state: "MERGED",
            mergedAt: "2026-10-31T00:00:00Z",
            mergeable: "MERGEABLE",
            autoMergeRequest: null,
            mergeQueueEntry: null,
          },
        },
      },
      errors,
    }),
  );
  await assert.rejects(
    host.getPullRequest("owner/repo", 81),
    (error: unknown) => {
      assert.ok(error instanceof Error);
      assert.equal(
        error.message,
        "GitHub returned GraphQL errors for Pull Request state",
      );
      const cause: unknown = error.cause;
      assert.ok(
        !inspect(cause, { depth: null, showHidden: true }).includes(credential),
      );
      assert.partialDeepStrictEqual(cause, {
        response: { errors: [{ path }] },
        commandError: null,
      });
      return true;
    },
  );
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
