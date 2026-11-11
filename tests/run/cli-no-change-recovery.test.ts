/* eslint-disable @typescript-eslint/require-await -- Scripted external boundaries. */
import assert from "node:assert/strict";
import { writeFile, rm, readFile } from "node:fs/promises";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import type { ImplementationProgress } from "../../src/recovery.ts";
import { executeCli } from "../../src/cli.ts";
import {
  implementationRun,
  publish,
  committed,
  implementationCommand,
} from "../support/implementation-run.ts";
import { passed } from "../support/review-run.ts";
import { validConfig } from "../support/cli-project.ts";
import { assessment, noChangeReviewRun } from "../support/no-change-run.ts";

await test("an accepted no-change Review survives restart without rerunning either Agent", async (t) => {
  const fixture = await noChangeReviewRun(t);
  fixture.state.onClose = async () => {
    if (fixture.state.closedTabs.length === 2) fixture.controller.abort();
  };
  assert.equal((await fixture.run()).summary.outcome, "cancelled");
  const saved = await fixture.snapshot();
  assert.equal(saved.noChange?.review?.result?.outcome, "passed");
  const before = fixture.state.submissions.length;
  const result = await executeCli(implementationCommand, {
    ...fixture.dependencies,
    signal: new AbortController().signal,
  });
  assert.equal(result.summary.outcome, "succeeded", JSON.stringify(result));
  assert.equal(fixture.state.submissions.length, before);
  assert.equal(fixture.noChangeState.comments.length, 1);
});

for (const stage of ["review", "fix"] as const) {
  await test(`interrupted no-change ${stage} reuses the native session and assigned handoff`, async (t) => {
    const fixture = await noChangeReviewRun(t);
    fixture.noChangeState.onReview = async (review) => {
      if (stage === "review") return;
      await writeFile(review.findings, "Implement the missing requirement.\n");
      await publish(review.invocation!.path, {
        outcome: "findings",
        summary: "Missing requirement.",
        commits: [],
        findings_file: review.findings,
      });
    };
    fixture.noChangeState.onFix = async () => {
      /* Interrupt while waiting. */
    };
    fixture.state.onSleep = async (ms) => {
      if (ms === 250) fixture.controller.abort();
    };
    assert.equal((await fixture.run()).summary.outcome, "cancelled");
    const saved = await fixture.snapshot();
    const active =
      stage === "review" ? saved.noChange!.review! : saved.noChange!.fix!;
    const before = fixture.state.submissions.length;
    fixture.state.onSleep = async (ms) => {
      if (ms !== 250) return;
      if (stage === "review") await publish(active.invocation!.path, passed());
      else {
        fixture.state.evidence.commits = committed().commits;
        fixture.state.evidence.changed = true;
        await publish(active.invocation!.path, committed());
      }
    };
    const result = await executeCli(implementationCommand, {
      ...fixture.dependencies,
      signal: new AbortController().signal,
    });
    assert.equal(
      result.summary.outcome,
      stage === "review" ? "succeeded" : "incomplete",
      JSON.stringify(result),
    );
    const texts = fixture.state.submissions
      .slice(before)
      .map(({ text }) => text);
    assert.equal(
      texts[0],
      stage === "review"
        ? 'review-cli resume "review-native/$&"'
        : 'any-cli --resume "native/$&/$`/$\'/session"',
    );
    assert.equal(texts[1], "continue");
    const resumed = await fixture.snapshot();
    assert.equal(resumed.execution_id, saved.execution_id);
    assert.deepEqual(resumed.roles, saved.roles);
    assert.equal(
      resumed.noChange![stage]!.invocation!.path,
      active.invocation!.path,
    );
    assert.deepEqual(resumed.noChange!.assessment, saved.noChange!.assessment);
    assert.equal(fixture.state.taskCount, 1);
    assert.equal(fixture.state.probeCount, 2);
  });
}

for (const window of ["fix accepted", "implementation promoted"] as const) {
  await test(`restart after ${window} preserves commits and matching PR metadata before round 1`, async (t) => {
    const fixture = await noChangeReviewRun(t);
    fixture.noChangeState.onReview = async (review) => {
      await writeFile(review.findings, "Implement the missing requirement.\n");
      await publish(review.invocation!.path, {
        outcome: "findings",
        summary: "Missing requirement.",
        commits: [],
        findings_file: review.findings,
      });
    };
    if (window === "fix accepted") {
      fixture.state.onClose = async () => {
        if (fixture.state.closedTabs.length === 3) fixture.controller.abort();
      };
    } else {
      const now = fixture.dependencies.clock.now.bind(
        fixture.dependencies.clock,
      );
      fixture.dependencies.clock.now = () => {
        const file = checkpointFile(fixture.directory);
        if (file) {
          const saved = JSON.parse(
            readFileSync(file, "utf8"),
          ) as ImplementationProgress;
          if (
            saved.noChange?.fix?.result &&
            saved.result?.outcome === "committed" &&
            !saved.reviews
          )
            fixture.controller.abort();
        }
        return now();
      };
    }
    assert.equal((await fixture.run()).summary.outcome, "cancelled");
    const saved = await fixture.snapshot();
    assert.equal(saved.noChange?.fix?.result?.outcome, "committed");
    assert.equal(
      saved.result?.outcome,
      window === "fix accepted" ? "no_change" : "committed",
    );
    if (window === "implementation promoted")
      assert.equal(saved.pr_title, committed().pr_title);
    fixture.dependencies.clock.now = () => new Date("2026-10-30T00:00:00Z");
    const before = fixture.state.submissions.length;
    const result = await executeCli(implementationCommand, {
      ...fixture.dependencies,
      signal: new AbortController().signal,
    });
    assert.equal(result.summary.outcome, "incomplete", JSON.stringify(result));
    assert.match(result.summary.tickets![0]!.detail, /CI-ready/u);
    const resumed = await fixture.snapshot();
    assert.equal(resumed.reviews?.length, 1);
    assert.equal(resumed.result?.pr_title, committed().pr_title);
    assert.equal(resumed.pr_title, resumed.result.pr_title);
    assert.equal(resumed.publication?.title, resumed.result.pr_title);
    assert.deepEqual(resumed.noChange!.assessment, assessment);
    assert.ok(
      fixture.state.submissions
        .slice(before)
        .every(({ text }) => !text.startsWith("No-change")),
    );
  });
}

for (const window of [
  "comment published",
  "comment recorded",
  "Issue closed",
  "completion recorded",
  "worktree removed",
  "cleanup finished",
] as const) {
  await test(`no-change delivery resumes after ${window}`, async (t) => {
    const fixture = await noChangeReviewRun(t);
    const comment = fixture.dependencies.tracker.commentTicket.bind(
      fixture.dependencies.tracker,
    );
    fixture.dependencies.tracker.commentTicket = async (...args) => {
      await comment(...args);
      if (window === "comment published") fixture.controller.abort();
    };
    const close = fixture.dependencies.tracker.closeTicket.bind(
      fixture.dependencies.tracker,
    );
    fixture.dependencies.tracker.closeTicket = async () => {
      await close();
      if (window === "Issue closed") fixture.controller.abort();
    };
    const cleanup = fixture.dependencies.gitWorkspace.cleanupWorktree.bind(
      fixture.dependencies.gitWorkspace,
    );
    fixture.dependencies.gitWorkspace.cleanupWorktree = async (input) => {
      await cleanup(input);
      await rm(input.worktree, { recursive: true, force: true });
      if (window === "worktree removed") {
        fixture.controller.abort();
        fixture.controller.signal.throwIfAborted();
      }
    };
    const now = fixture.dependencies.clock.now.bind(fixture.dependencies.clock);
    fixture.dependencies.clock.now = () => {
      const file = checkpointFile(fixture.directory);
      if (file) {
        const saved = JSON.parse(
          readFileSync(file, "utf8"),
        ) as ImplementationProgress;
        if (
          (window === "comment recorded" &&
            saved.noChange?.delivery?.phase === "commented") ||
          (window === "completion recorded" &&
            saved.noChange?.delivery?.phase === "delivered") ||
          (window === "cleanup finished" &&
            saved.cleanup?.files.includes(
              `${saved.noChange!.review!.findings}.tmp`,
            ))
        )
          fixture.controller.abort();
      }
      return now();
    };
    assert.equal(
      (await fixture.run()).summary.outcome,
      "cancelled",
      JSON.stringify(fixture.dependencies.messages),
    );
    const saved = await fixture.snapshot();
    assert.equal(
      saved.noChange?.delivery?.phase,
      window === "comment published"
        ? "pending_comment"
        : ["comment recorded", "Issue closed"].includes(window)
          ? "commented"
          : "delivered",
    );
    if (window === "worktree removed")
      assert.equal(existsSync(saved.worktree), false);
    if (window === "worktree removed")
      assert.deepEqual(saved.cleanup?.worktrees, []);
    fixture.dependencies.clock.now = now;
    fixture.dependencies.tracker.commentTicket = comment;
    fixture.dependencies.tracker.closeTicket = close;
    fixture.dependencies.gitWorkspace.cleanupWorktree = async (input) => {
      await cleanup(input);
      await rm(input.worktree, { recursive: true, force: true });
    };
    const before = fixture.state.submissions.length;
    const result = await executeCli(implementationCommand, {
      ...fixture.dependencies,
      signal: new AbortController().signal,
    });
    assert.equal(result.summary.outcome, "succeeded", JSON.stringify(result));
    assert.equal(result.summary.tickets![0]!.status, "completed");
    assert.equal(fixture.state.submissions.length, before);
    assert.equal(
      fixture.noChangeState.comments.length,
      window === "comment published" ? 2 : 1,
    );
    assert.equal(
      fixture.noChangeState.comments[0],
      saved.noChange.delivery.comment,
    );
    assert.equal(
      (await fixture.snapshot()).noChange?.delivery?.phase,
      "delivered",
    );
    assert.equal(existsSync(saved.worktree), false);
  });
}

function checkpointFile(directory: string) {
  const recovery = path.join(directory, "recovery");
  const file = existsSync(recovery)
    ? readdirSync(recovery).find((file) => file.endsWith("-50.json"))
    : undefined;
  return file ? path.join(recovery, file) : undefined;
}

await test("an existing no-change implementation checkpoint enters dedicated Review after restart", async (t) => {
  const fixture = await noChangeReviewRun(t);
  fixture.state.onClose = async () => {
    if (fixture.state.closedTabs.length === 1) fixture.controller.abort();
  };
  assert.equal((await fixture.run()).summary.outcome, "cancelled");
  const saved = await fixture.snapshot();
  assert.equal(saved.noChange, undefined);
  const result = await executeCli(implementationCommand, {
    ...fixture.dependencies,
    signal: new AbortController().signal,
  });
  assert.equal(result.summary.outcome, "succeeded");
  assert.equal(fixture.state.taskCount, 1);
  assert.equal(
    (await fixture.snapshot()).noChange?.review?.result?.outcome,
    "passed",
  );
});

for (const ticketClosure of ["runner", "code_host"]) {
  await test(`existing no-change checkpoints recover with byte-identical legacy ${ticketClosure} configuration`, async (t) => {
    const config = { ...validConfig, ticketClosure };
    const fixture = await implementationRun(t, config);
    fixture.state.onTask = async (file) => {
      fixture.state.evidence.changed = false;
      await publish(file, assessment);
    };
    fixture.state.onClose = async () => fixture.controller.abort();
    assert.equal((await fixture.run()).summary.outcome, "cancelled");
    const saved = await fixture.snapshot();
    assert.equal(saved.noChange, undefined);
    const bytes = await readFile(path.join(fixture.directory, "config.yaml"));
    Object.assign(fixture.dependencies.tracker, {
      async commentTicket() {
        /* Scripted successful comment. */
      },
      async closeTicket() {
        fixture.state.ticket.state = "closed";
        fixture.state.ticket.stateReason = "completed";
      },
    });
    const result = await executeCli(implementationCommand, {
      ...fixture.dependencies,
      signal: new AbortController().signal,
    });
    assert.equal(result.summary.outcome, "succeeded");
    const resumed = await fixture.snapshot();
    assert.equal(resumed.input_hash, saved.input_hash);
    assert.equal(resumed.execution_id, saved.execution_id);
    assert.equal(resumed.noChange?.review, undefined);
    assert.deepEqual(
      await readFile(path.join(fixture.directory, "config.yaml")),
      bytes,
    );
    assert.equal(fixture.state.taskCount, 1);
  });
}

for (const invalid of [
  "reviewed SHA",
  "findings ownership",
  "completion evidence",
] as const) {
  await test(`invalid no-change ${invalid} prevents continuation and cleanup`, async (t) => {
    const fixture = await noChangeReviewRun(t);
    fixture.state.onClose = async () => {
      if (fixture.state.closedTabs.length === 2) fixture.controller.abort();
    };
    assert.equal((await fixture.run()).summary.outcome, "cancelled");
    const saved = await fixture.snapshot();
    if (invalid === "reviewed SHA") saved.noChange!.head = "d".repeat(40);
    if (invalid === "findings ownership")
      saved.noChange!.review!.findings = "/tmp/foreign-findings.md";
    if (invalid === "completion evidence") {
      saved.noChange!.delivery = {
        phase: "delivered",
        comment: "Unconfirmed completion.",
      };
      await rm(saved.worktree, { recursive: true });
    }
    await writeFile(checkpointFile(fixture.directory)!, JSON.stringify(saved));
    fixture.dependencies.operator.pause = async (message) => {
      assert.match(message, /restart the entire Issue/u);
      return "q";
    };
    const before = fixture.state.submissions.length;
    assert.equal(
      (
        await executeCli(implementationCommand, {
          ...fixture.dependencies,
          signal: new AbortController().signal,
        })
      ).summary.outcome,
      "cancelled",
    );
    assert.equal(fixture.state.submissions.length, before);
    assert.equal(fixture.noChangeState.comments.length, 0);
    assert.equal(fixture.state.cleanup.length, 0);
  });
}
