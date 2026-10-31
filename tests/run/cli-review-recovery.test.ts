/* eslint-disable @typescript-eslint/require-await -- Scripted external boundaries. */
import assert from "node:assert/strict";
import { access, rm, writeFile } from "node:fs/promises";
import test from "node:test";
import { executeCli } from "../../src/cli.ts";
import {
  committed,
  implementationCommand,
  implementationCommit,
  publish,
} from "../support/implementation-run.ts";
import {
  findings,
  fixCommit,
  passed,
  reviewRun,
} from "../support/review-run.ts";

for (const stage of ["review", "fix"] as const) {
  await test(`an invalid retained ${stage} result corrects in the original role without gaining a Review round`, async (t) => {
    const fixture = await reviewRun(t, 1, { agentRetry: 1 });
    fixture.reviewState.onReview =
      stage === "review"
        ? async () => {
            /* Leave Review in flight for the restarted Run. */
          }
        : findings;
    fixture.reviewState.onFix = async () => {
      /* Leave the fix in flight for the restarted Run. */
    };
    fixture.state.onSleep = async (ms) => {
      if (ms === 250) fixture.controller.abort();
    };
    assert.equal((await fixture.run()).summary.outcome, "cancelled");
    const saved = await fixture.snapshot();
    const round = saved.reviews![0]!;
    const active = stage === "review" ? round : round.fix!;
    await publish(active.invocation!.path, {
      outcome: "no_change",
      summary: "Nothing changed.",
      commits: [],
      findings_file: null,
    });
    fixture.reviewState.onCorrection = async (current, purpose) => {
      assert.equal(purpose, stage);
      assert.equal(current.round, 1);
      assert.equal(current.base, round.base);
      assert.equal(current.head, round.head);
      const corrected = stage === "review" ? current : current.fix!;
      assert.equal(corrected.corrections, 1);
      assert.deepEqual(corrected.superseded, [active.invocation!.path]);
      if (stage === "review") await findings(current);
      else {
        fixture.state.evidence.commits.push(fixCommit);
        await publish(corrected.invocation!.path, {
          ...committed(),
          commits: [fixCommit],
        });
      }
    };
    fixture.reviewState.onFix = async (current) => {
      fixture.state.evidence.commits.push(fixCommit);
      await publish(current.fix!.invocation!.path, {
        ...committed(),
        commits: [fixCommit],
      });
    };
    const before = fixture.state.submissions.length;
    const result = await executeCli(implementationCommand, {
      ...fixture.dependencies,
      signal: new AbortController().signal,
    });
    assert.match(result.summary.reasons.join(" "), /CI-ready/u);
    const resumed = await fixture.snapshot();
    assert.equal(resumed.execution_id, saved.execution_id);
    assert.equal(resumed.worktree, saved.worktree);
    assert.deepEqual(resumed.roles, saved.roles);
    assert.equal(resumed.pr_title, saved.pr_title);
    assert.equal(resumed.pr_body, saved.pr_body);
    assert.equal(resumed.reviews!.length, 1);
    assert.equal(fixture.state.probeCount, 2);
    const submissions = fixture.state.submissions.slice(before);
    assert.equal(
      submissions[0]!.text,
      stage === "review"
        ? 'review-cli resume "review-native/$&"'
        : 'any-cli --resume "native/$&/$`/$\'/session"',
    );
    assert.match(
      submissions[1]!.text,
      stage === "review"
        ? /^Correct the Review handoff:/u
        : /no_change cannot satisfy findings/u,
    );
    assert.equal(
      submissions.some(({ text }) => text === "continue"),
      false,
    );
    assert.deepEqual(resumed.publication!.commits, [
      implementationCommit,
      fixCommit,
    ]);
    await assert.rejects(access(round.findings));
  });
}

for (const report of ["missing", "empty"] as const) {
  await test(`a required ${report} findings report offers explicit recovery failure before resuming the fix`, async (t) => {
    const fixture = await reviewRun(t, 1);
    fixture.reviewState.onReview = findings;
    fixture.reviewState.onFix = async () => fixture.controller.abort();
    assert.equal((await fixture.run()).summary.outcome, "cancelled");
    const saved = await fixture.snapshot();
    const round = saved.reviews![0]!;
    if (report === "missing") await rm(round.findings);
    else await writeFile(round.findings, " \n");
    const before = fixture.state.submissions.length;
    let pauses = 0;
    fixture.dependencies.operator.pause = async (message) => {
      assert.equal(
        message,
        "Enter to restart the entire Issue #50, or q to exit Runner.",
      );
      pauses += 1;
      return "q";
    };
    const result = await executeCli(implementationCommand, {
      ...fixture.dependencies,
      signal: new AbortController().signal,
    });
    assert.equal(result.summary.outcome, "cancelled");
    assert.equal(pauses, 1);
    assert.ok(fixture.dependencies.messages.includes("unable to recover"));
    assert.equal(fixture.state.submissions.length, before);
    assert.deepEqual(await fixture.snapshot(), saved);
    assert.deepEqual(fixture.state.cleanup, []);
    await access(saved.worktree);
  });
}

for (const stage of ["review", "fix"] as const) {
  await test(`a completed ${stage} checkpoint skips its Agent work and preserves the final-round fix`, async (t) => {
    const fixture = await reviewRun(t, 1);
    fixture.reviewState.onReview = findings;
    fixture.state.onClose = async () => {
      if (fixture.state.closedTabs.length === (stage === "review" ? 2 : 3))
        fixture.controller.abort();
    };
    assert.equal((await fixture.run()).summary.outcome, "cancelled");
    const saved = await fixture.snapshot();
    const round = saved.reviews![0]!;
    assert.equal(
      saved.phase,
      stage === "review" ? "review_completed" : "fix_review_completed",
    );
    await access(round.findings);
    // Completed stages use checkpoint facts, not later handoff overwrites.
    await publish(round.invocation!.path, passed());
    if (round.fix)
      await publish(round.fix.invocation!.path, {
        ...committed(),
        outcome: "no_change",
        commits: [],
      });
    const before = fixture.state.submissions.length;
    const result = await executeCli(implementationCommand, {
      ...fixture.dependencies,
      signal: new AbortController().signal,
    });
    assert.match(result.summary.reasons.join(" "), /CI-ready/u);
    assert.equal(fixture.reviewState.reviews.length, 1);
    assert.equal(fixture.reviewState.fixes.length, 1);
    const submissions = fixture.state.submissions.slice(before);
    if (stage === "review") {
      assert.equal(submissions.length, 2);
      assert.equal(
        submissions[0]!.text,
        'any-cli --resume "native/$&/$`/$\'/session"',
      );
      assert.match(submissions[1]!.text, /^Fix assignment\n/u);
    } else assert.deepEqual(submissions, []);
    const resumed = await fixture.snapshot();
    assert.equal(resumed.phase, "publication_eligible");
    assert.equal(resumed.reviews!.length, 1);
    assert.equal(resumed.pr_title, saved.pr_title);
    assert.equal(resumed.pr_body, saved.pr_body);
    assert.deepEqual(resumed.publication!.commits, [
      implementationCommit,
      fixCommit,
    ]);
    await assert.rejects(access(round.findings));
  });
}
