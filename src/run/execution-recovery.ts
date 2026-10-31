import path from "node:path";
import { existsSync } from "node:fs";
import type { LoadedProject } from "../config.ts";
import type { ImplementationProgress } from "../recovery.ts";
import { nonempty, object, readHandoff } from "../agent/handoff.ts";
import { validateReviewContext } from "./review.ts";
import { validateRepairContext } from "./repair.ts";

export async function restoreExecution(input: {
  file: string;
  loaded: LoadedProject;
  project: string;
  number: number;
  repository: string;
  targetBranch: string;
  documentation: boolean;
  runId: string;
}): Promise<ImplementationProgress | undefined> {
  const {
    file,
    loaded,
    project,
    number,
    repository,
    targetBranch,
    documentation,
    runId,
  } = input;
  const purpose = documentation ? "documentation" : "implement";
  try {
    const previous = await readHandoff(file);
    if (previous !== undefined) {
      const saved = object(JSON.parse(previous.text) as unknown);
      if (
        saved.project !== project ||
        saved.ticket !== number ||
        saved.repository !== repository ||
        saved.target_branch !== targetBranch ||
        saved.purpose !== (documentation ? "documentation" : undefined) ||
        !nonempty(saved.execution_id) ||
        !nonempty(saved.run_id) ||
        !nonempty(saved.worktree) ||
        !path.isAbsolute(saved.worktree) ||
        !nonempty(saved.branch) ||
        !nonempty(saved.base) ||
        (![
          "implementing",
          "documenting",
          ...(documentation ? ["reserved", "worktree_created", "probing"] : []),
        ].includes(String(saved.phase)) &&
          saved.result === undefined) ||
        ![
          "implementing",
          "implementation_completed",
          "documenting",
          "documentation_completed",
          ...(documentation ? ["reserved", "worktree_created", "probing"] : []),
          "reviewing",
          "review_completed",
          "fixing_review",
          "fix_review_completed",
          "repairing_ci",
          "ci_repair_completed",
          "repairing_conflict",
          "conflict_repair_completed",
          "publication_eligible",
        ].includes(String(saved.phase))
      )
        throw new Error(
          "unable to recover: incomplete or invalid implementation checkpoint",
        );
      const roles = object(saved.roles);
      const early =
        documentation &&
        ["reserved", "worktree_created", "probing"].includes(
          String(saved.phase),
        );
      const implement = object(roles[purpose] ?? {});
      const invocation = object(saved.invocation ?? {});
      if (
        (!early &&
          (!nonempty(implement.sessionid) ||
            !nonempty(saved.pr_title) ||
            !nonempty(saved.pr_body) ||
            !nonempty(invocation.invocation_id) ||
            !nonempty(invocation.path) ||
            path.dirname(invocation.path) !==
              path.join(loaded.directory, "handoffs"))) ||
        !Number.isSafeInteger(saved.corrections) ||
        (saved.corrections as number) < 0 ||
        (saved.probeRetries !== undefined &&
          (!Number.isSafeInteger(saved.probeRetries) ||
            (saved.probeRetries as number) < 0)) ||
        (saved.probeIds !== undefined &&
          (!Array.isArray(saved.probeIds) ||
            !saved.probeIds.every(nonempty))) ||
        (saved.pendingPrompt !== undefined && !nonempty(saved.pendingPrompt)) ||
        !Array.isArray(saved.superseded)
      )
        throw new Error(
          "unable to recover: missing native implementation context",
        );
      const restored = saved as unknown as ImplementationProgress;
      if (documentation) {
        const owned = (value: unknown): value is string =>
          nonempty(value) &&
          path.isAbsolute(value) &&
          path.dirname(value) === path.join(loaded.directory, "handoffs");
        if (
          saved.run_id !== runId ||
          saved.worktree !==
            path.join(
              loaded.directory,
              "worktrees",
              restored.execution_id,
              `ticket-${number}`,
            ) ||
          saved.branch !== `issue-runner/${restored.run_id}/ticket-${number}` ||
          saved.reviews !== undefined ||
          !restored.superseded.every(owned) ||
          (restored.probe !== undefined &&
            (!nonempty(restored.probe.probe_id) ||
              !owned(restored.probe.path))) ||
          (restored.invocation !== undefined &&
            (!nonempty(restored.invocation.invocation_id) ||
              !owned(restored.invocation.path))) ||
          (saved.noChangeClosure !== undefined &&
            ((saved.noChangeClosure !== "pending" &&
              saved.noChangeClosure !== "completed") ||
              restored.result?.outcome !== "no_change" ||
              restored.phase !== "documentation_completed" ||
              restored.publication !== undefined))
        )
          throw new Error(
            "unable to recover: invalid documentation execution ownership or closure",
          );
        if (
          restored.phase === "probing" &&
          !nonempty(implement.sessionid) &&
          (!restored.probe || !(await readHandoff(restored.probe.path)))
        )
          throw new Error(
            "unable to recover: missing native documentation identity; retain the Worktree and complete the assigned Probe before recovery",
          );
        if (
          restored.phase !== "reserved" &&
          restored.noChangeClosure !== "completed" &&
          restored.publication?.phase !== "delivered" &&
          !existsSync(restored.worktree)
        )
          throw new Error(
            "unable to recover: original documentation Worktree is missing",
          );
      }
      if (!documentation) validateReviewContext(restored, loaded);
      validateRepairContext(restored, loaded);
      return restored;
    }
  } catch (error) {
    if (
      !documentation ||
      (error instanceof Error && error.message.startsWith("unable to recover"))
    )
      throw error;
    throw new Error(
      "unable to recover: invalid documentation execution context",
      { cause: error },
    );
  }
}
