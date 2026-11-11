/* eslint-disable @typescript-eslint/require-await -- Scripted external boundaries. */
import assert from "node:assert/strict";
import test from "node:test";
import { GitHubTracker } from "../../src/adapters/github-tracker.ts";
import { implementationRun, publish } from "../support/implementation-run.ts";

await test("GitHub no-change comment preserves evidence and retries failure before completed closure", async (t) => {
  const fixture = await implementationRun(t);
  const summary =
    'Already implemented. Checks passed: $& `literal` "quoted" 中文\nLimit: no live deployment.';
  fixture.state.onTask = async (file) => {
    fixture.state.evidence.changed = false;
    await publish(file, {
      outcome: "no_change",
      summary,
      commits: [],
      findings_file: null,
      pr_title: "fix: [issue-50] existing behavior",
      pr_body: "Already implemented.\n\nCloses #50",
    });
  };
  let comments = 0;
  const tracker = new GitHubTracker("tracker-secret", async (args, options) => {
    assert.equal(options.token, "tracker-secret");
    if (args[0] === "api") {
      assert.deepEqual(args.slice(0, 5), [
        "api",
        "--method",
        "POST",
        "repos/owner/repo/issues/50/comments",
        "-f",
      ]);
      assert.ok(args[5]!.includes(summary));
      assert.match(args[5]!, /Reviewed commit: a{40}/u);
      if (++comments === 1) throw new Error("comment response lost");
    } else {
      assert.equal(comments, 2);
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
    }
    return "";
  });
  Object.assign(fixture.dependencies.tracker, {
    commentTicket: tracker.commentTicket.bind(tracker),
    closeTicket: tracker.closeTicket.bind(tracker),
  });
  assert.equal((await fixture.run()).summary.outcome, "succeeded");
  assert.equal(comments, 2);
});
