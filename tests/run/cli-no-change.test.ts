/* eslint-disable @typescript-eslint/require-await -- Scripted external boundaries. */
import assert from "node:assert/strict";
import { writeFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { executeCli } from "../../src/cli.ts";
import {
  implementationRun,
  publish,
  committed,
  implementationCommand,
} from "../support/implementation-run.ts";
import { passed } from "../support/review-run.ts";
import { assessment, noChangeReviewRun } from "../support/no-change-run.ts";

await test("Review-disabled no_change publishes evidence, closes and cleans without a PR", async (t) => {
  const fixture = await implementationRun(t);
  const comments: string[] = [];
  fixture.state.onTask = async (file) => {
    fixture.state.evidence.changed = false;
    await publish(file, {
      outcome: "no_change",
      summary:
        "Already implemented. Ran the focused tests: passed. No live checks.",
      commits: [],
      findings_file: null,
      pr_title: "fix: [issue-50] existing behavior satisfies requirements",
      pr_body: "Already implemented.\n\nCloses #50",
    });
  };
  Object.assign(fixture.dependencies.tracker, {
    async commentTicket(_repository: string, _ticket: number, body: string) {
      comments.push(body);
    },
    async closeTicket() {
      assert.equal(comments.length, 1);
      fixture.state.ticket.state = "closed";
      fixture.state.ticket.stateReason = "completed";
    },
  });
  const result = await fixture.run();
  assert.equal(result.summary.outcome, "succeeded");
  assert.equal(result.summary.tickets![0]!.status, "completed");
  assert.match(
    result.summary.tickets![0]!.detail,
    /no.change.*Review disabled/iu,
  );
  assert.equal(comments.length, 1);
  assert.match(
    comments[0]!,
    /Already implemented.*focused tests: passed.*No live checks/su,
  );
  assert.match(comments[0]!, /Review disabled/u);
  assert.match(comments[0]!, /a{40}/u);
  assert.equal(fixture.state.probeCount, 1);
  assert.equal(fixture.state.cleanup.length, 1);
  assert.deepEqual(await fixture.dependencies.codeHost.listPullRequests(), []);
});

await test("passed no-change Review uses Session B without consuming an ordinary round", async (t) => {
  const fixture = await noChangeReviewRun(t);
  const result = await fixture.run();
  assert.equal(result.summary.outcome, "succeeded");
  const saved = await fixture.snapshot();
  assert.equal(saved.noChange?.review?.result?.outcome, "passed");
  assert.equal(saved.reviews, undefined);
  assert.equal(saved.roles.review?.sessionid, "review-native/$&");
  assert.equal(fixture.noChangeState.comments.length, 1);
  assert.match(
    fixture.noChangeState.comments[0]!,
    /Standards and Spec passed/u,
  );
  assert.equal(fixture.state.probeCount, 2);
});

await test("no-change findings resume A with fresh PR metadata, then resume B for ordinary round 1", async (t) => {
  const fixture = await noChangeReviewRun(t);
  fixture.noChangeState.onReview = async (review) => {
    await writeFile(review.findings, "Implement the missing requirement.\n");
    await publish(review.invocation!.path, {
      outcome: "findings",
      summary: "Missing requirement; existing test fails.",
      commits: [],
      findings_file: review.findings,
    });
  };
  const result = await fixture.run();
  assert.equal(result.summary.outcome, "incomplete");
  assert.match(result.summary.tickets![0]!.detail, /CI-ready/u);
  const saved = await fixture.snapshot();
  assert.deepEqual(saved.noChange?.assessment, assessment);
  assert.equal(saved.result?.outcome, "committed");
  assert.equal(saved.pr_title, committed().pr_title);
  assert.equal(saved.publication?.title, committed().pr_title);
  assert.equal(saved.reviews?.length, 1);
  assert.equal(saved.reviews[0]!.round, 1);
  assert.equal(saved.reviews[0]!.base, "a".repeat(40));
  assert.equal(fixture.state.probeCount, 2);
  assert.equal(fixture.state.taskCount, 1);
  const texts = fixture.state.submissions.map(({ text }) => text);
  assert.ok(texts.includes('any-cli --resume "native/$&/$`/$\'/session"'));
  assert.ok(texts.includes('review-cli resume "review-native/$&"'));
  assert.deepEqual(fixture.noChangeState.comments, []);
});

await test("comment failure never closes the Issue; recovery retries the saved body without reevaluating Review", async (t) => {
  const fixture = await noChangeReviewRun(t);
  let attempts = 0;
  const comment = fixture.dependencies.tracker.commentTicket.bind(
    fixture.dependencies.tracker,
  );
  fixture.dependencies.tracker.commentTicket = async () => {
    attempts++;
    throw new Error("comment unavailable");
  };
  fixture.dependencies.operator.pause = async (message) => {
    assert.match(message, /comment unavailable/u);
    return "q";
  };
  assert.equal((await fixture.run()).summary.outcome, "cancelled");
  assert.equal(attempts, 2);
  assert.equal(fixture.state.ticket.state, "open");
  assert.equal(fixture.state.cleanup.length, 0);
  const saved = await fixture.snapshot();
  assert.equal(saved.noChange?.delivery?.phase, "pending_comment");
  fixture.dependencies.tracker.commentTicket = comment;
  fixture.dependencies.operator.pause = async () => "";
  fixture.state.ticket.body =
    "Later edited requirements do not invalidate accepted conclusions.";
  const before = fixture.state.submissions.length;
  assert.equal(
    (
      await executeCli(implementationCommand, {
        ...fixture.dependencies,
        signal: new AbortController().signal,
      })
    ).summary.outcome,
    "succeeded",
  );
  assert.equal(fixture.state.submissions.length, before);
  assert.equal(
    fixture.noChangeState.comments[0],
    saved.noChange.delivery.comment,
  );
});

await test("a failed comment is retried before closure", async (t) => {
  const fixture = await noChangeReviewRun(t);
  let attempts = 0;
  Object.assign(fixture.dependencies.tracker, {
    async commentTicket(_repository: string, _ticket: number, body: string) {
      if (++attempts === 1) throw new Error("temporary comment failure");
      fixture.noChangeState.comments.push(body);
    },
  });
  assert.equal((await fixture.run()).summary.outcome, "succeeded");
  assert.equal(attempts, 2);
  assert.equal(fixture.state.ticket.stateReason, "completed");
});

await test("project no-change Review instructions supplement Core's dedicated prompt", async (t) => {
  const fixture = await noChangeReviewRun(t);
  await writeFile(
    path.join(fixture.directory, "prompts", "no-change-review.md"),
    "Project-specific no-change checks.",
  );
  assert.equal((await fixture.run()).summary.outcome, "succeeded");
  const prompt = fixture.state.submissions.find(({ text }) =>
    text.startsWith("No-change review assignment\n"),
  )!.text;
  assert.match(prompt, /Project-specific no-change checks/u);
  assert.match(prompt, /Reviewed commit: a{40}/u);
  assert.ok(prompt.includes(assessment.summary));
  assert.match(prompt, /actual checks and results, and limitations/u);
  assert.doesNotMatch(prompt, /Review round:/u);
});

for (const invalid of [
  "missing findings",
  "missing PR metadata",
  "no_change fix",
] as const) {
  await test(`no-change Review corrects ${invalid} in the original session`, async (t) => {
    const fixture = await noChangeReviewRun(t);
    fixture.noChangeState.onReview = async (review) => {
      if (invalid !== "missing findings")
        await writeFile(review.findings, "Implement missing requirement.\n");
      await publish(review.invocation!.path, {
        outcome: "findings",
        summary: "Missing accepted behavior.",
        commits: [],
        findings_file: review.findings,
      });
    };
    fixture.noChangeState.onFix = async (fix) => {
      const result: Record<string, unknown> = committed();
      if (invalid === "missing PR metadata") {
        delete result.pr_title;
        delete result.pr_body;
        fixture.state.evidence.changed = true;
        fixture.state.evidence.commits = committed().commits;
      } else {
        Object.assign(result, assessment);
      }
      await publish(fix.invocation!.path, result);
    };
    fixture.noChangeState.onCorrection = async (purpose) => {
      assert.equal(purpose, invalid === "missing findings" ? "review" : "fix");
      const saved = await fixture.snapshot();
      assert.equal(saved.reviews, undefined);
      assert.equal(saved.roles.implement?.sessionid, "native/$&/$`/$'/session");
      if (purpose === "review")
        await publish(saved.noChange!.review!.invocation!.path, passed());
      else {
        fixture.state.evidence.changed = true;
        fixture.state.evidence.commits = committed().commits;
        await publish(saved.noChange!.fix!.invocation!.path, committed());
      }
    };
    const result = await fixture.run();
    assert.equal(
      result.summary.outcome,
      invalid === "missing findings" ? "succeeded" : "incomplete",
      JSON.stringify(result),
    );
    const saved = await fixture.snapshot();
    assert.equal(fixture.state.probeCount, 2);
    assert.equal(
      saved.noChange![invalid === "missing findings" ? "review" : "fix"]!
        .superseded.length,
      1,
    );
    if (invalid !== "missing findings") assert.equal(saved.reviews?.length, 1);
  });
}

await test("no-change findings consume no budget before the ordinary Review cap and final fix", async (t) => {
  const fixture = await noChangeReviewRun(t);
  fixture.noChangeState.onReview = async (review) => {
    await writeFile(review.findings, "Missing implementation.\n");
    await publish(review.invocation!.path, {
      outcome: "findings",
      summary: "Missing implementation.",
      commits: [],
      findings_file: review.findings,
    });
  };
  fixture.reviewState.onReview = async (round) => {
    await writeFile(round.findings, "One more fix.\n");
    await publish(round.invocation!.path, {
      outcome: "findings",
      summary: "One more fix.",
      commits: [],
      findings_file: round.findings,
    });
  };
  assert.equal((await fixture.run()).summary.outcome, "incomplete");
  const saved = await fixture.snapshot();
  assert.equal(saved.reviews?.length, 1);
  assert.equal(saved.reviews[0]!.fix?.result?.outcome, "committed");
  assert.equal(saved.publication?.commits.length, 2);
  assert.deepEqual(saved.noChange!.assessment, assessment);
});

await test("a lost closure response reconciles completed state even without automatic retries", async (t) => {
  const fixture = await noChangeReviewRun(t, { operationRetry: 0 });
  let closures = 0;
  fixture.dependencies.tracker.closeTicket = async () => {
    closures++;
    fixture.state.ticket.state = "closed";
    fixture.state.ticket.stateReason = "completed";
    throw new Error("closure response lost");
  };
  assert.equal((await fixture.run()).summary.outcome, "succeeded");
  assert.equal(closures, 1);
});

for (const state of ["open", "not_planned"] as const) {
  await test(`no-change closure cannot complete while the Issue is ${state}`, async (t) => {
    const fixture = await noChangeReviewRun(t);
    fixture.dependencies.tracker.closeTicket = async () => {
      if (state === "not_planned") {
        fixture.state.ticket.state = "closed";
        fixture.state.ticket.stateReason = "not_planned";
      }
    };
    fixture.dependencies.operator.pause = async (message) => {
      assert.match(message, /closure has not been confirmed/u);
      return "q";
    };
    assert.equal(
      (await fixture.run()).summary.outcome,
      state === "open" ? "cancelled" : "incomplete",
    );
    assert.equal(
      (await fixture.snapshot()).noChange?.delivery?.phase,
      "commented",
    );
    assert.equal(fixture.state.cleanup.length, 0);
  });
}
