/* eslint-disable @typescript-eslint/require-await -- Scripted external boundaries. */
import assert from "node:assert/strict";
import type { TestContext } from "node:test";
import type { NoChangeProgress } from "../../src/recovery.ts";
import { reviewRun, passed } from "./review-run.ts";
import { committed, publish } from "./implementation-run.ts";

export const assessment = {
  outcome: "no_change",
  summary:
    "Already implemented. Ran the focused tests: passed. No live checks.",
  commits: [],
  findings_file: null,
  pr_title: "fix: [issue-50] existing behavior satisfies requirements",
  pr_body: "Already implemented.\n\nCloses #50",
};

export async function noChangeReviewRun(
  t: TestContext,
  config: Parameters<typeof reviewRun>[2] = {},
) {
  const fixture = await reviewRun(t, 1, config);
  const state = {
    comments: [] as string[],
    onReview: async (review: NonNullable<NoChangeProgress["review"]>) =>
      publish(review.invocation!.path, passed()),
    onFix: async (fix: NonNullable<NoChangeProgress["fix"]>) => {
      fixture.state.evidence.commits = committed().commits;
      fixture.state.evidence.changed = true;
      await publish(fix.invocation!.path, committed());
    },
    onCorrection: async (_purpose: "review" | "fix"): Promise<void> => {
      assert.fail(`unexpected no-change ${_purpose} correction`);
    },
  };
  fixture.state.onTask = async (file) => {
    fixture.state.evidence.changed = false;
    await publish(file, assessment);
  };
  Object.assign(fixture.dependencies.tracker, {
    async commentTicket(_repository: string, _ticket: number, body: string) {
      state.comments.push(body);
    },
    async closeTicket() {
      fixture.state.ticket.state = "closed";
      fixture.state.ticket.stateReason = "completed";
    },
  });
  const submit = fixture.dependencies.terminalPlugin.onInput.bind(
    fixture.dependencies.terminalPlugin,
  );
  fixture.dependencies.terminalPlugin.onInput = async (tab, text, chord) => {
    await submit(tab, text, chord);
    if (text.startsWith("No-change review assignment\n"))
      await state.onReview((await fixture.snapshot()).noChange!.review!);
    if (text.startsWith("No-change fix assignment\n"))
      await state.onFix((await fixture.snapshot()).noChange!.fix!);
    if (!(await fixture.snapshot()).reviews) {
      if (text.startsWith("Correct the Review handoff:"))
        await state.onCorrection("review");
      if (text.startsWith("Correct the Review fix handoff:"))
        await state.onCorrection("fix");
    }
  };
  return { ...fixture, noChangeState: state };
}
