import path from "node:path";
import type { LoadedProject } from "../config.ts";
import type { ImplementationProgress } from "../recovery.ts";
import {
  nonempty,
  object,
  parsePRExecution,
  parseReview,
} from "../agent/handoff.ts";
import { validateReviewStage } from "./review.ts";

export function validateNoChangeContext(
  progress: ImplementationProgress,
  loaded: LoadedProject,
): void {
  const invalid = () =>
    new Error("unable to recover: incomplete or invalid no-change context");
  const owned = (file: unknown): file is string =>
    nonempty(file) &&
    path.isAbsolute(file) &&
    path.dirname(file) === path.join(loaded.directory, "handoffs");
  if (progress.noChange !== undefined) {
    const noChange = object(progress.noChange);
    const assessment = parsePRExecution(JSON.stringify(noChange.assessment));
    if (assessment.outcome !== "no_change" || noChange.head !== progress.base)
      throw invalid();
    const review = progress.noChange.review;
    if (review !== undefined) {
      validateReviewStage(review, loaded);
      if (
        !owned(review.findings) ||
        !path
          .basename(review.findings)
          .startsWith(`${progress.ticket}-no-change-findings-`) ||
        !review.findings.endsWith(".md") ||
        (review.invocation && !nonempty(progress.roles.review?.sessionid))
      )
        throw invalid();
      if (review.result !== undefined) {
        review.result = parseReview(
          JSON.stringify(review.result),
          review.findings,
        );
        if (!review.invocation) throw invalid();
      }
    }
    const fix = progress.noChange.fix;
    if (fix !== undefined) {
      if (review?.result?.outcome !== "findings") throw invalid();
      validateReviewStage(fix, loaded);
      if (fix.result !== undefined) {
        fix.result = parsePRExecution(JSON.stringify(fix.result));
        if (fix.result.outcome !== "committed" || !fix.invocation)
          throw invalid();
      }
    }
    if (
      JSON.stringify(progress.result) !==
      JSON.stringify(
        progress.result?.outcome === "committed" ? fix?.result : assessment,
      )
    )
      throw invalid();
    const delivery = progress.noChange.delivery;
    if (delivery !== undefined) {
      if (
        progress.result?.outcome !== "no_change" ||
        progress.publication !== undefined ||
        progress.reviews !== undefined ||
        fix !== undefined ||
        (loaded.config.workflow.review &&
          review?.result?.outcome !== "passed") ||
        !nonempty(delivery.comment) ||
        !["pending_comment", "commented", "delivered"].includes(
          delivery.phase,
        ) ||
        (delivery.phase === "delivered" &&
          (delivery.closure?.state !== "closed" ||
            delivery.closure.stateReason !== "completed" ||
            !Array.isArray(delivery.deliveryLabels) ||
            !delivery.deliveryLabels.every(
              (label) => typeof label === "string",
            )))
      )
        throw invalid();
    }
  }
}
