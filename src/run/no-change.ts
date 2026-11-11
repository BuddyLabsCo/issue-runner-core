import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { runIssueStage, type IssueStageContext } from "../agent/stage.ts";
import {
  nonempty,
  parsePRExecution,
  parseReview,
  readHandoff,
} from "../agent/handoff.ts";
import { loadPrompt, renderPrompt } from "../prompts/load.ts";
import { closeDocumentationNoChange } from "./integration.ts";
import { cleanupExecution } from "./cleanup.ts";
import type { RunSummary } from "./run.ts";
import type { TicketReport } from "./report.ts";
import type { ReadOperation } from "./discovery.ts";
import type { GitWorkspace, Ticket, Tracker } from "./contracts.ts";
import { OperationStopped } from "./operations.ts";
import { verifyWorkspace } from "./verification.ts";

const noChangeReviewInstructions = loadPrompt("no-change-review");
const noChangeFixInstructions = loadPrompt("no-change-fix");

export async function completeNoChange(
  input: IssueStageContext & {
    git: GitWorkspace;
    tracker: Tracker;
    read: ReadOperation;
    inspectTicket: () => Promise<{ ticket: Ticket; reason?: string }>;
    summary: RunSummary;
    report: TicketReport;
    closeResidual: () => Promise<void>;
    verify: () => Promise<void>;
    onDelivery?: (labels: string[]) => void;
  },
): Promise<RunSummary | undefined> {
  const { progress, loaded, summary, report } = input;
  if (progress.purpose === "documentation") {
    await closeDocumentationNoChange(input);
    await input.closeResidual();
    report.detail = `Completed Maintenance Ticket ${progress.ticket} with no changes`;
    return { ...summary, outcome: "succeeded" };
  }
  if (loaded.config.workflow.review && !progress.noChange?.delivery) {
    await reviewNoChange(input);
    if (progress.result?.outcome === "committed") return;
    if (progress.noChange?.review?.result?.outcome !== "passed") {
      report.detail = "No-change Review or implementation remains incomplete";
      return summary;
    }
  }
  try {
    const labels = await deliverNoChange(input);
    await input.closeResidual();
    await cleanupExecution(input);
    input.onDelivery?.(labels);
    report.detail = `Completed Issue #${progress.ticket} with no_change; ${progress.noChange?.review ? "Review passed" : "Review disabled"}`;
    return { ...summary, outcome: "succeeded" };
  } catch (error) {
    if (!(error instanceof OperationStopped)) throw error;
    report.detail = error.message;
    return summary;
  }
}

async function reviewNoChange(
  input: IssueStageContext & {
    git: GitWorkspace;
    read: ReadOperation;
  },
): Promise<void> {
  const { progress, loaded, persist, read } = input;
  const noChange = (progress.noChange ??= {
    assessment: progress.result!,
    head: progress.base,
  });
  const review = (noChange.review ??= {
    findings: path.join(
      loaded.directory,
      "handoffs",
      `${progress.ticket}-no-change-findings-${randomUUID()}.md`,
    ),
    superseded: [],
  });
  await persist();
  if (!review.result) {
    await runIssueStage({
      ...input,
      stage: review,
      purpose: "review",
      progressLabel: "no-change review",
      task: async (handoffPath) => {
        let instructions = "";
        try {
          instructions = await readFile(
            path.join(loaded.directory, "prompts", "no-change-review.md"),
            "utf8",
          );
        } catch (error) {
          if (!(
            error instanceof Error &&
            "code" in error &&
            error.code === "ENOENT"
          ))
            throw error;
        }
        return renderPrompt(noChangeReviewInstructions, {
          issue: String(progress.ticket),
          head: noChange.head,
          assessment: JSON.stringify(noChange.assessment, null, 2),
          findings: JSON.stringify(review.findings),
          instructions,
          path: JSON.stringify(handoffPath),
        });
      },
      accept: async (text) => {
        const result = parseReview(text, review.findings);
        if (
          result.outcome === "findings" &&
          !nonempty((await readHandoff(review.findings))?.text)
        )
          throw new Error("Review findings must be a regular nonempty report");
        verifyWorkspace(
          progress,
          await read(
            "inspect_no_change_review",
            `ticket:${progress.ticket}`,
            () => input.git.inspect(progress),
          ),
          noChange.assessment,
        );
        return result;
      },
    });
  }
  if (review.result?.outcome !== "findings") return;
  const fix = (noChange.fix ??= { superseded: [] });
  if (!fix.result) {
    if (!nonempty((await readHandoff(review.findings))?.text))
      throw new Error(
        "unable to recover: Review findings report is missing or empty",
      );
    await runIssueStage({
      ...input,
      stage: fix,
      purpose: "fix_review",
      progressLabel: "no-change fix",
      task: (handoffPath) =>
        renderPrompt(noChangeFixInstructions, {
          issue: String(progress.ticket),
          findings: JSON.stringify(review.findings),
          base: noChange.head,
          path: JSON.stringify(handoffPath),
        }),
      accept: async (text) => {
        const result = parsePRExecution(text);
        if (result.outcome !== "committed")
          throw new Error(
            "Review findings require a committed implementation; no_change cannot satisfy findings",
          );
        verifyWorkspace(
          progress,
          await read("inspect_no_change_fix", `ticket:${progress.ticket}`, () =>
            input.git.inspect(progress),
          ),
          result,
        );
        return result;
      },
    });
  }
  if (!fix.result) return;
  progress.result = fix.result;
  progress.pr_title = fix.result.pr_title;
  progress.pr_body = fix.result.pr_body;
  progress.phase = "implementation_completed";
  await persist();
}

async function deliverNoChange(
  input: IssueStageContext & {
    tracker: Tracker;
    read: ReadOperation;
    inspectTicket: () => Promise<{ ticket: Ticket; reason?: string }>;
  },
): Promise<string[]> {
  const { progress, persist, read, tracker } = input;
  const noChange = (progress.noChange ??= {
    assessment: progress.result!,
    head: progress.base,
  });
  const delivery = (noChange.delivery ??= {
    phase: "pending_comment",
    comment: [
      "Completed with no changes.",
      `Implementation assessment:\n${noChange.assessment.summary}`,
      noChange.review?.result
        ? `Review:\n${noChange.review.result.summary}`
        : "Review disabled (workflow.review=false).",
      `Reviewed commit: ${noChange.head}`,
    ].join("\n\n"),
  });
  await persist();
  if (delivery.phase === "pending_comment") {
    await read(
      "publish_no_change_comment",
      `ticket:${progress.ticket}`,
      async () => {
        if (!(await input.beforeDispatch()))
          throw new OperationStopped(
            "Issue eligibility changed before no-change comment",
          );
        await tracker.commentTicket(
          progress.repository,
          progress.ticket,
          delivery.comment,
        );
      },
    );
    delivery.phase = "commented";
    await persist();
  }
  const completion = async () => {
    const selected = await input.inspectTicket();
    if (selected.ticket.state === "closed") {
      if (selected.ticket.stateReason !== "completed")
        throw new OperationStopped("Issue is not closed/completed");
      if (!Array.isArray(selected.ticket.labels))
        throw new Error("Delivery requires observed Issue labels");
    } else if (
      delivery.phase === "delivered" ||
      selected.reason ||
      !(await input.beforeDispatch())
    ) {
      throw new OperationStopped(
        selected.reason ?? "Completed Issue reopened or Reservation changed",
      );
    }
    return selected.ticket;
  };
  const current = await read(
    "close_no_change_issue",
    `ticket:${progress.ticket}`,
    async () => {
      let current = await completion();
      if (current.state !== "closed") {
        await tracker.closeTicket(progress.repository, progress.ticket);
        current = await completion();
        if (current.state !== "closed")
          throw new Error("Issue closure has not been confirmed");
      }
      return current;
    },
    {
      reconcile: async () => {
        const current = await completion();
        return current.state === "closed"
          ? { outcome: "completed", result: current }
          : { outcome: "pending" };
      },
    },
  );
  delivery.closure = { state: "closed", stateReason: "completed" };
  delivery.deliveryLabels ??= [...current.labels!];
  delivery.phase = "delivered";
  await persist();
  return delivery.deliveryLabels;
}
