/* eslint-disable @typescript-eslint/require-await -- Scripted external boundaries. */
import assert from "node:assert/strict";
import { access, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { documentationRun } from "../support/documentation-run.ts";
import { findings, passed, reviewRun } from "../support/review-run.ts";
import { conflictRepairRun } from "../support/conflict-repair-run.ts";
import { ciRepairRun } from "../support/ci-repair-run.ts";
import { noChangeReviewRun } from "../support/no-change-run.ts";
import {
  committed,
  implementationRun,
  publish,
} from "../support/implementation-run.ts";
import { updateConfig } from "../support/run-scope.ts";

async function assertRetained(...files: (string | undefined)[]) {
  for (const file of files) {
    assert.ok(file);
    await access(file);
  }
}

function updateAgent(
  fixture: { directory: string },
  role: string,
  values: Record<string, unknown>,
) {
  return updateConfig(fixture, (config) => ({
    ...config,
    agents: {
      ...(config.agents as Record<string, Record<string, unknown>>),
      [role]: {
        ...(config.agents as Record<string, Record<string, unknown>>)[role],
        ...values,
      },
    },
  }));
}

await test("a changed recorded Review identity requires an explicit restart", async (t) => {
  const fixture = await reviewRun(t);
  fixture.reviewState.onReview = async (round) => {
    await writeFile(round.invocation!.path, "{}");
    fixture.controller.abort();
  };
  assert.equal((await fixture.run()).summary.outcome, "cancelled");
  const saved = await fixture.snapshot();
  assert.deepEqual(saved.roles.review, {
    sessionid: "review-native/$&",
    agent: "review-agent",
    resume: 'review-cli resume "review-native/$&"',
  });
  await updateAgent(fixture, "review", { agent: "changed-review-agent" });
  fixture.dependencies.signal = new AbortController().signal;
  fixture.dependencies.operator.pause = async () => "q";
  const result = await fixture.run();
  assert.equal(result.summary.outcome, "cancelled");
  assert.ok(fixture.dependencies.messages.includes("unable to recover"));
  const round = saved.reviews![0]!;
  await assertRetained(
    saved.worktree,
    saved.probe?.path,
    saved.invocation?.path,
    round.probe?.path,
    round.invocation?.path,
  );
  assert.deepEqual(fixture.state.cleanup, []);
});

await test("a corrupt recorded Documentation identity requires an explicit restart", async (t) => {
  const fixture = await documentationRun(t);
  fixture.state.onTask = async () => fixture.controller.abort();
  assert.equal((await fixture.run()).summary.outcome, "cancelled");
  const saved = await fixture.snapshot();
  assert.equal(saved.roles.documentation?.agent, "document-agent");
  await writeFile(saved.invocation!.path, "{}");
  const file = path.join(
    fixture.directory,
    "recovery",
    `${saved.input_hash}-document-50.json`,
  );
  await writeFile(
    file,
    JSON.stringify({
      ...saved,
      roles: {
        documentation: {
          ...saved.roles.documentation,
          agent: "changed-document-agent",
        },
      },
    }),
  );
  fixture.dependencies.signal = new AbortController().signal;
  fixture.dependencies.operator.pause = async () => "q";
  const result = await fixture.run();
  assert.equal(result.summary.outcome, "cancelled");
  assert.ok(fixture.dependencies.messages.includes("unable to recover"));
  await assertRetained(
    saved.worktree,
    saved.probe?.path,
    saved.invocation?.path,
  );
  assert.deepEqual(fixture.maintenance.cleanup, []);
});

await test("a changed identity for a role the remaining workflow cannot resume is ignored", async (t) => {
  const fixture = await implementationRun(t);
  fixture.state.onTask = async () => fixture.controller.abort();
  assert.equal((await fixture.run()).summary.outcome, "cancelled");
  const saved = await fixture.snapshot();
  await writeFile(
    path.join(fixture.directory, "recovery", `${saved.input_hash}-50.json`),
    JSON.stringify({
      ...saved,
      roles: {
        ...saved.roles,
        documentation: {
          sessionid: "old-document-native",
          agent: "old-document-agent",
          resume: 'old-document-cli --resume "old-document-native"',
        },
      },
    }),
  );
  await updateAgent(fixture, "documentation", {
    agent: "new-document-agent",
    start: "new-document-cli",
    resume: 'new-document-cli --resume "{sessionref}"',
  });
  fixture.dependencies.signal = new AbortController().signal;
  fixture.state.evidence.commits = committed().commits;
  fixture.state.evidence.changed = true;
  fixture.state.onSleep = async (ms) => {
    if (ms === 250) await publish(saved.invocation!.path, committed());
  };
  const before = fixture.state.submissions.length;
  const result = await fixture.run();
  assert.match(result.summary.tickets![0]!.detail ?? "", /CI-ready/u);
  const current = await fixture.snapshot();
  assert.equal(current.execution_id, saved.execution_id);
  assert.deepEqual(
    fixture.state.submissions
      .slice(before)
      .map(({ text }) => text)
      .slice(0, 1),
    [`any-cli --resume "${saved.roles.implement!.sessionid}"`],
  );
});

await test("Agent changes for completed implementation and Review conversations do not block publication recovery", async (t) => {
  const fixture = await reviewRun(t);
  fixture.state.onClose = async () => {
    if (fixture.state.closedTabs.length === 2) fixture.controller.abort();
  };
  assert.equal((await fixture.run()).summary.outcome, "cancelled");
  const saved = await fixture.snapshot();
  assert.equal(saved.phase, "review_completed");
  assert.equal(saved.reviews?.[0]?.result?.outcome, "passed");
  assert.ok(saved.roles.implement);
  assert.ok(saved.roles.review);
  await updateAgent(fixture, "implement", { agent: "changed-implement-agent" });
  await updateAgent(fixture, "review", {
    resume: 'changed-review --resume "{sessionref}"',
  });
  fixture.dependencies.signal = new AbortController().signal;
  const before = fixture.state.submissions.length;
  const result = await fixture.run();
  assert.match(result.summary.tickets![0]!.detail ?? "", /CI-ready/u);
  assert.ok(!fixture.dependencies.messages.includes("unable to recover"));
  assert.equal(fixture.state.submissions.length, before);
  assert.equal((await fixture.snapshot()).execution_id, saved.execution_id);
});

await test("a future Review round requires the saved Review identity", async (t) => {
  const fixture = await reviewRun(t);
  fixture.reviewState.onReview = async (round) => {
    if (round.round === 1) await findings(round);
  };
  fixture.state.onClose = async () => {
    if (fixture.state.closedTabs.length === 3) fixture.controller.abort();
  };
  assert.equal((await fixture.run()).summary.outcome, "cancelled");
  const saved = await fixture.snapshot();
  assert.equal(saved.reviews?.at(-1)?.result?.outcome, "findings");
  assert.ok(saved.reviews?.at(-1)?.fix?.result);
  await updateAgent(fixture, "review", { agent: "changed-review-agent" });
  fixture.dependencies.signal = new AbortController().signal;
  fixture.dependencies.operator.pause = async () => "q";
  const before = fixture.state.submissions.length;
  const result = await fixture.run();
  assert.equal(result.summary.outcome, "cancelled");
  assert.ok(fixture.dependencies.messages.includes("unable to recover"));
  assert.equal(fixture.state.submissions.length, before);
});

await test("an unfinished Review fix requires the saved implement identity", async (t) => {
  const fixture = await reviewRun(t, 1);
  fixture.reviewState.onReview = findings;
  fixture.reviewState.onFix = async () => {
    /* Leave the fix in flight. */
  };
  fixture.state.onSleep = async (ms) => {
    if (ms === 250) fixture.controller.abort();
  };
  assert.equal((await fixture.run()).summary.outcome, "cancelled");
  const saved = await fixture.snapshot();
  assert.equal(saved.phase, "fixing_review");
  assert.ok(saved.reviews?.[0]?.fix);
  await updateAgent(fixture, "implement", {
    resume: 'changed-implement --resume "{sessionref}"',
  });
  fixture.dependencies.signal = new AbortController().signal;
  fixture.dependencies.operator.pause = async () => "q";
  const before = fixture.state.submissions.length;
  const result = await fixture.run();
  assert.equal(result.summary.outcome, "cancelled");
  assert.ok(fixture.dependencies.messages.includes("unable to recover"));
  assert.equal(fixture.state.submissions.length, before);
});

await test("a pending Review protects the saved implement identity for a possible fix", async (t) => {
  const fixture = await reviewRun(t, 1);
  fixture.reviewState.onReview = async () => {
    /* Leave the Review in flight. */
  };
  fixture.state.onSleep = async (ms) => {
    if (ms === 250) fixture.controller.abort();
  };
  assert.equal((await fixture.run()).summary.outcome, "cancelled");
  const saved = await fixture.snapshot();
  assert.equal(saved.reviews?.[0]?.result, undefined);
  assert.ok(saved.roles.implement);
  await updateAgent(fixture, "implement", { agent: "changed-implement-agent" });
  fixture.dependencies.signal = new AbortController().signal;
  fixture.dependencies.operator.pause = async () => "q";
  const before = fixture.state.submissions.length;
  const result = await fixture.run();
  assert.equal(result.summary.outcome, "cancelled");
  assert.ok(fixture.dependencies.messages.includes("unable to recover"));
  assert.equal(fixture.state.submissions.length, before);
});

await test("an unfinished no-change fix requires the saved implement identity", async (t) => {
  const fixture = await noChangeReviewRun(t);
  fixture.noChangeState.onReview = async (review) => {
    await writeFile(review.findings, "Implement the missing requirement.\n");
    await publish(review.invocation!.path, {
      ...passed(),
      outcome: "findings",
      summary: "Missing requirement.",
      findings_file: review.findings,
    });
  };
  fixture.noChangeState.onFix = async () => {
    /* Leave the fix in flight. */
  };
  fixture.state.onSleep = async (ms) => {
    if (ms === 250) fixture.controller.abort();
  };
  assert.equal((await fixture.run()).summary.outcome, "cancelled");
  const saved = await fixture.snapshot();
  assert.equal(saved.phase, "fixing_review");
  assert.ok(saved.noChange?.fix);
  await updateAgent(fixture, "implement", { agent: "changed-implement-agent" });
  fixture.dependencies.signal = new AbortController().signal;
  fixture.dependencies.operator.pause = async () => "q";
  const before = fixture.state.submissions.length;
  const result = await fixture.run();
  assert.equal(result.summary.outcome, "cancelled");
  assert.ok(fixture.dependencies.messages.includes("unable to recover"));
  assert.equal(fixture.state.submissions.length, before);
});

await test("an accepted no-change fix still requires the saved Review identity", async (t) => {
  const fixture = await noChangeReviewRun(t);
  fixture.noChangeState.onReview = async (review) => {
    await writeFile(review.findings, "Implement the missing requirement.\n");
    await publish(review.invocation!.path, {
      ...passed(),
      outcome: "findings",
      summary: "Missing requirement.",
      findings_file: review.findings,
    });
  };
  fixture.state.onClose = async () => {
    if (fixture.state.closedTabs.length === 3) fixture.controller.abort();
  };
  assert.equal((await fixture.run()).summary.outcome, "cancelled");
  const saved = await fixture.snapshot();
  assert.equal(saved.result?.outcome, "no_change");
  assert.equal(saved.noChange?.fix?.result?.outcome, "committed");
  await updateAgent(fixture, "review", { agent: "changed-review-agent" });
  fixture.dependencies.signal = new AbortController().signal;
  fixture.dependencies.operator.pause = async () => "q";
  const before = fixture.state.submissions.length;
  const result = await fixture.run();
  assert.equal(result.summary.outcome, "cancelled");
  assert.ok(fixture.dependencies.messages.includes("unable to recover"));
  assert.equal(fixture.state.submissions.length, before);
});

await test("a pending no-change Review requires the saved Review identity", async (t) => {
  const fixture = await noChangeReviewRun(t);
  fixture.noChangeState.onReview = async () => {
    /* Leave the no-change Review in flight. */
  };
  fixture.state.onSleep = async (ms) => {
    if (ms === 250) fixture.controller.abort();
  };
  assert.equal((await fixture.run()).summary.outcome, "cancelled");
  const saved = await fixture.snapshot();
  assert.ok(saved.noChange?.review);
  assert.equal(saved.noChange.review.result, undefined);
  await updateAgent(fixture, "review", {
    resume: 'changed-review --resume "{sessionref}"',
  });
  fixture.dependencies.signal = new AbortController().signal;
  fixture.dependencies.operator.pause = async () => "q";
  const before = fixture.state.submissions.length;
  const result = await fixture.run();
  assert.equal(result.summary.outcome, "cancelled");
  assert.ok(fixture.dependencies.messages.includes("unable to recover"));
  assert.equal(fixture.state.submissions.length, before);
});

await test("a Probe path without a handoff starts a new session with the current Review configuration", async (t) => {
  const fixture = await noChangeReviewRun(t);
  fixture.noChangeState.onReview = async () => {
    /* Interrupt before the Review handoff is accepted. */
  };
  fixture.state.onSleep = async (ms) => {
    if (ms === 250) fixture.controller.abort();
  };
  assert.equal((await fixture.run()).summary.outcome, "cancelled");
  const saved = await fixture.snapshot();
  assert.ok(saved.noChange?.review?.probe);
  delete saved.roles.review;
  delete saved.noChange.review.invocation;
  delete saved.noChange.review.pendingPrompt;
  await rm(saved.noChange.review.probe.path);
  await writeFile(
    path.join(fixture.directory, "recovery", `${saved.input_hash}-50.json`),
    JSON.stringify(saved),
  );
  await updateAgent(fixture, "review", {
    agent: "changed-review-agent",
    start: "changed-review-cli start",
    resume: 'changed-review-cli resume "{sessionref}"',
  });
  fixture.dependencies.signal = new AbortController().signal;
  fixture.noChangeState.onReview = async (review) =>
    publish(review.invocation!.path, passed());
  fixture.state.onSleep = async () => {
    /* The resumed Review must settle without another interruption. */
  };
  const commands: string[] = [];
  fixture.dependencies.terminalPlugin.execute = async (_tab, command) => {
    commands.push(command);
    return "current-review-native";
  };
  const result = await fixture.run();
  assert.equal(result.summary.outcome, "succeeded", JSON.stringify(result));
  assert.deepEqual(commands, [
    "changed-review-cli start",
    (await fixture.snapshot()).roles.implement!.resume,
  ]);
  assert.equal(
    (await fixture.snapshot()).roles.review?.sessionid,
    "current-review-native",
  );
});

await test("a completed CI repair ignores changed repair identity while its push recovers", async (t) => {
  const fixture = await ciRepairRun(t);
  fixture.state.onClose = async () => {
    if (fixture.state.closedTabs.length === 2) fixture.controller.abort();
  };
  assert.equal((await fixture.run()).summary.outcome, "cancelled");
  const saved = await fixture.snapshot();
  const attempt = saved.publication!.ciRepair!.attempts[0]!;
  assert.ok(attempt.result);
  assert.equal(attempt.pushed, undefined);
  await updateAgent(fixture, "ciRepair", {
    agent: "changed-ci-repair-agent",
  });
  fixture.dependencies.signal = new AbortController().signal;
  const pushes = fixture.publicationState.pushes;
  const result = await fixture.run();
  assert.match(result.summary.tickets![0]!.detail ?? "", /CI-ready/u);
  assert.ok(!fixture.dependencies.messages.includes("unable to recover"));
  const current = await fixture.snapshot();
  assert.equal(current.execution_id, saved.execution_id);
  assert.equal(current.publication!.ciRepair!.attempts[0]!.pushed, true);
  assert.equal(fixture.publicationState.pushes, pushes + 1);
});

await test("a changed recorded conflict repair identity requires an explicit restart", async (t) => {
  const fixture = await conflictRepairRun(t);
  fixture.repairs.onTask = async () => fixture.controller.abort();
  assert.equal((await fixture.run()).summary.outcome, "cancelled");
  const saved = await fixture.snapshot();
  const attempt = saved.publication!.conflictRepair!.attempts.at(-1)!;
  assert.ok(attempt.agent);
  assert.ok(attempt.resume);
  await writeFile(attempt.invocation!.path, "{}");
  await updateAgent(fixture, "conflictRepair", {
    resume: 'changed-conflict --resume "{sessionref}"',
  });
  fixture.dependencies.signal = new AbortController().signal;
  fixture.dependencies.operator.pause = async () => "q";
  const result = await fixture.run();
  assert.equal(result.summary.outcome, "cancelled");
  assert.ok(fixture.dependencies.messages.includes("unable to recover"));
  await assertRetained(
    saved.worktree,
    attempt.worktree,
    attempt.probe?.path,
    attempt.invocation?.path,
  );
});
