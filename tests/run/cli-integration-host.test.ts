/* eslint-disable @typescript-eslint/require-await -- Scripted external boundaries. */
import assert from "node:assert/strict";
import test from "node:test";
import { GitHubCodeHost } from "../../src/adapters/github-code-host.ts";
import { GitHubTracker } from "../../src/adapters/github-tracker.ts";
import { integrationRun } from "../support/integration-run.ts";
import { implementationCommit } from "../support/implementation-run.ts";

await test("GitHub integration uses squash, observed HEAD, admin policy, queue observation and completed closure", async (t) => {
  const fixture = await integrationRun(t);
  let queued = false;
  let merged = false;
  let requests = 0;
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
    assert.equal(args[0], "api");
    assert.equal(args[1], "graphql");
    assert.ok(args.includes("number=81"));
    assert.ok(args.includes("owner=owner"));
    assert.ok(args.includes("name=repo"));
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
  const tracker = new GitHubTracker("tracker-secret", async (args, options) => {
    assert.equal(options.token, "tracker-secret");
    assert.equal(merged, true);
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
  });
  fixture.state.onSleep = async () => {
    if (queued) merged = true;
  };
  const result = await fixture.run();
  assert.equal(result.summary.outcome, "succeeded", JSON.stringify(result));
  assert.equal(requests, 1);
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
