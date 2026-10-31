import { randomUUID } from "node:crypto";
import { readFile, rm } from "node:fs/promises";
import path from "node:path";
import { runIssueStage, type IssueStageContext } from "../agent/stage.ts";
import {
  nonempty,
  object,
  parseExecution,
  parseReview,
  readHandoff,
} from "../agent/handoff.ts";
import {
  reviewFixInstructions,
  reviewInstructions,
} from "../prompts/review.ts";
import type { ImplementationProgress, StageProgress } from "../recovery.ts";
import type { LoadedProject } from "../config.ts";
import type { GitWorkspace } from "./contracts.ts";
import type { ReadOperation } from "./discovery.ts";
import { verifyWorkspace } from "./verification.ts";

export function verifiedImplementation(progress: ImplementationProgress) {
  return {
    ...progress.result!,
    commits: [
      ...progress.result!.commits,
      ...(progress.reviews ?? []).flatMap(
        (round) => round.fix?.result?.commits ?? [],
      ),
    ],
  };
}

export function validateReviewContext(
  progress: ImplementationProgress,
  loaded: LoadedProject,
): void {
  const invalid = () =>
    new Error("unable to recover: incomplete or invalid Review/fix context");
  if (progress.reviews === undefined) {
    if (
      ![
        "implementing",
        "implementation_completed",
        "repairing_ci",
        "ci_repair_completed",
        "repairing_conflict",
        "conflict_repair_completed",
      ].includes(progress.phase)
    )
      throw invalid();
    return;
  }
  const directory = path.join(loaded.directory, "handoffs");
  const owned = (file: unknown): file is string =>
    nonempty(file) && path.isAbsolute(file) && path.dirname(file) === directory;
  const validateStage = (value: StageProgress<unknown>) => {
    const stage = object(value);
    if (
      !Number.isSafeInteger(stage.corrections) ||
      (stage.corrections as number) < 0 ||
      !Array.isArray(stage.superseded) ||
      !stage.superseded.every(owned) ||
      (stage.pendingPrompt !== undefined && !nonempty(stage.pendingPrompt)) ||
      (stage.probeRetries !== undefined &&
        (!Number.isSafeInteger(stage.probeRetries) ||
          (stage.probeRetries as number) < 0))
    )
      throw invalid();
    for (const [key, id] of [
      ["probe", undefined],
      ["invocation", "invocation_id"],
    ] as const) {
      if (stage[key] === undefined) continue;
      const assignment = object(stage[key]);
      if (
        (id !== undefined && !nonempty(assignment[id])) ||
        !owned(assignment.path)
      )
        throw invalid();
    }
  };
  if (
    !Array.isArray(progress.reviews) ||
    progress.reviews.length === 0 ||
    !nonempty(progress.roles.review?.sessionid)
  )
    throw invalid();
  let handoff = parseExecution(JSON.stringify(progress.result));
  if (handoff.outcome !== "committed") throw invalid();
  for (const [index, round] of progress.reviews.entries()) {
    object(round);
    if (
      round.round !== index + 1 ||
      round.base !==
        (index === 0 ? progress.base : progress.reviews[index - 1]!.head) ||
      round.head !== handoff.commits.at(-1)!.sha ||
      !owned(round.findings) ||
      !path
        .basename(round.findings)
        .startsWith(`${progress.ticket}-review-findings-`) ||
      !round.findings.endsWith(".md") ||
      (index > 0 && progress.reviews[index - 1]!.fix?.result === undefined)
    )
      throw invalid();
    validateStage(round);
    if (round.result !== undefined) {
      round.result = parseReview(JSON.stringify(round.result), round.findings);
      if (!round.invocation) throw invalid();
    }
    if (round.fix !== undefined) {
      if (round.result?.outcome !== "findings") throw invalid();
      validateStage(round.fix);
      if (round.fix.result !== undefined) {
        const result = parseExecution(JSON.stringify(round.fix.result));
        if (result.outcome !== "committed" || !round.fix.invocation)
          throw invalid();
        handoff = {
          ...handoff,
          commits: [...handoff.commits, ...result.commits],
        };
      }
    }
  }
  const last = progress.reviews.at(-1)!;
  const cap = loaded.config.workflow.maxReviewRounds;
  if (
    (cap !== undefined && progress.reviews.length > cap) ||
    (progress.phase === "publication_eligible" &&
      last.result?.outcome !== "passed" &&
      !(cap !== undefined && last.round === cap && last.fix?.result))
  )
    throw invalid();
}

export async function reviewImplementation(
  input: IssueStageContext & {
    git: GitWorkspace;
    read: ReadOperation;
  },
): Promise<void> {
  const { loaded, progress, read } = input;
  let handoff = progress.result!;
  const reviews = (progress.reviews ??= []);
  for (let index = 0; ; index += 1) {
    const round = reviews[index] ?? {
      round: index + 1,
      base: index === 0 ? progress.base : reviews[index - 1]!.head,
      head: handoff.commits.at(-1)!.sha,
      findings: path.join(
        loaded.directory,
        "handoffs",
        `${progress.ticket}-review-findings-${randomUUID()}.md`,
      ),
      corrections: 0,
      superseded: [],
    };
    if (reviews.length === index) {
      reviews.push(round);
      progress.phase = "reviewing";
      await input.persist();
    }
    if (!round.result) {
      await runIssueStage({
        ...input,
        stage: round,
        purpose: "review",
        task: async () =>
          `${reviewInstructions.replace("{{issue}}", () => String(progress.ticket))}\n\n${await readFile(path.join(loaded.directory, "prompts", "review.md"), "utf8")}\n\n` +
          `Review base: ${round.base}\nImplementation HEAD: ${round.head}\nAssigned findings path: ${JSON.stringify(round.findings)}`,
        accept: async (text) => {
          const result = parseReview(text, round.findings);
          if (result.outcome === "findings") {
            const report = await readHandoff(round.findings);
            if (!report || !nonempty(report.text))
              throw new Error(
                "Review findings must be a regular nonempty report",
              );
          }
          const evidence = await read(
            "inspect_review",
            `ticket:${progress.ticket}`,
            () => input.git.inspect(progress),
          );
          verifyWorkspace(progress, evidence, handoff);
          return result;
        },
      });
    }
    if (!round.result) return;
    if (round.result.outcome === "passed") break;
    if (!round.fix) {
      round.fix = { corrections: 0, superseded: [] };
      progress.phase = "fixing_review";
      await input.persist();
    }
    if (!round.fix.result) {
      const report = await readHandoff(round.findings);
      if (!report || !nonempty(report.text))
        throw new Error(
          "unable to recover: Review findings report is missing or empty",
        );
      await runIssueStage({
        ...input,
        stage: round.fix,
        purpose: "fix_review",
        task: () =>
          `${reviewFixInstructions}\n\nFindings report: ${JSON.stringify(round.findings)}\nBase SHA: ${round.head}`,
        accept: async (text) => {
          const result = parseExecution(text);
          if (result.outcome !== "committed")
            throw new Error(
              "Review findings require a committed fix; no_change cannot satisfy findings",
            );
          const fixBase = { ...progress, base: round.head };
          verifyWorkspace(
            fixBase,
            await read("inspect_review_fix", `ticket:${progress.ticket}`, () =>
              input.git.inspect(fixBase),
            ),
            result,
          );
          verifyWorkspace(
            progress,
            await read(
              "inspect_accumulated_fixes",
              `ticket:${progress.ticket}`,
              () => input.git.inspect(progress),
            ),
            { ...handoff, commits: [...handoff.commits, ...result.commits] },
          );
          return result;
        },
      });
    }
    if (!round.fix.result) return;
    handoff = {
      ...handoff,
      commits: [...handoff.commits, ...round.fix.result.commits],
    };
    if (
      loaded.config.workflow.maxReviewRounds !== undefined &&
      round.round >= loaded.config.workflow.maxReviewRounds
    )
      break;
  }
  progress.phase = "publication_eligible";
  await input.persist();
  await read(
    "cleanup_review_findings",
    `ticket:${progress.ticket}`,
    async () => {
      for (const round of reviews) {
        await rm(round.findings, { force: true });
        await rm(`${round.findings}.tmp`, { force: true });
      }
    },
  );
}
