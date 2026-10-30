import { writeFile } from "node:fs/promises";
import type { TestContext } from "node:test";
import type { ReviewProgress } from "../../src/recovery.ts";
import { committed, implementationRun, publish } from "./implementation-run.ts";
import { validConfig } from "./cli-project.ts";

export const fixCommit = {
  sha: "c".repeat(40),
  message: "fix: address Review",
};

export async function reviewRun(
  t: TestContext,
  maxReviewRounds?: number,
  config: Partial<typeof validConfig> = {},
) {
  const fixture = await implementationRun(t, {
    ...validConfig,
    ...config,
    workflow: {
      review: true,
      ...(maxReviewRounds === undefined ? {} : { maxReviewRounds }),
    },
    agents: {
      ...validConfig.agents,
      review: {
        ...validConfig.agents.review,
        start: "review-cli start",
        resume: 'review-cli resume "{sessionref}"',
      },
    },
  });
  const state = {
    reviews: [] as ReviewProgress[],
    fixes: [] as ReviewProgress[],
    onReview: async (round: ReviewProgress) => {
      await publish(round.invocation!.path, passed());
    },
    onFix: async (round: ReviewProgress) => {
      fixture.state.evidence.commits.push(fixCommit);
      await publish(round.fix!.invocation!.path, {
        outcome: "committed",
        summary: "Fixed Review findings.",
        commits: [fixCommit],
        findings_file: null,
      });
    },
    onCorrection: async (round: ReviewProgress, purpose: "review" | "fix") => {
      if (purpose === "review") await state.onReview(round);
      else await state.onFix(round);
    },
  };
  const onProbe = fixture.state.onProbe;
  fixture.state.onProbe = async (assignment) => {
    if (assignment.role === "review") {
      await publish(String(assignment.path), {
        ...assignment,
        sessionid: "review-native/$&",
      });
    } else await onProbe(assignment);
  };
  const submit = fixture.dependencies.terminalPlugin.submitText.bind(
    fixture.dependencies.terminalPlugin,
  );
  fixture.dependencies.terminalPlugin.submitText = async (tab, text, chord) => {
    await submit(tab, text, chord);
    const round = (await fixture.snapshot()).reviews?.at(-1);
    if (text.startsWith("Review assignment\n")) {
      state.reviews.push(round!);
      await state.onReview(round!);
    } else if (text.startsWith("Fix assignment\n")) {
      state.fixes.push(round!);
      await state.onFix(round!);
    } else if (text.startsWith("Correct the Review handoff:")) {
      await state.onCorrection(round!, "review");
    } else if (text.startsWith("Correct the Review fix handoff:")) {
      await state.onCorrection(round!, "fix");
    }
  };
  return { ...fixture, reviewState: state };
}

export function passed() {
  return {
    ...committed(),
    outcome: "passed",
    summary: "Standards and Spec passed.",
    commits: [],
  };
}

export async function findings(round: ReviewProgress) {
  await writeFile(round.findings, "Fix the missing accepted behavior.\n");
  await publish(round.invocation!.path, {
    outcome: "findings",
    summary: "Accepted behavior needs a fix.",
    commits: [],
    findings_file: round.findings,
  });
}
