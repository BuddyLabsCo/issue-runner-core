import type { RepairProgress } from "../recovery.ts";
import type { CodeHost, RequiredCheck } from "./contracts.ts";
import type { ReadOperation } from "./discovery.ts";
import { pauseForOperator } from "./operations.ts";
import type { IssueStageContext } from "../agent/stage.ts";

export function validCiRerunCheckpoint(
  repair: RepairProgress,
  kind: "ci" | "conflict",
): boolean {
  const { actionsRerun, checksReconciled } = repair;
  if (actionsRerun === undefined && checksReconciled === undefined) return true;
  if (
    kind !== "ci" ||
    repair.result?.outcome !== "no_change" ||
    repair.verificationError
  )
    return false;
  if (checksReconciled !== undefined && checksReconciled !== true) return false;
  if (actionsRerun === undefined) return true;
  return (
    actionsRerun !== null &&
    typeof actionsRerun.runId === "string" &&
    /^[1-9]\d*$/u.test(actionsRerun.runId) &&
    Number.isSafeInteger(actionsRerun.previousAttempt) &&
    actionsRerun.previousAttempt >= 0
  );
}

export async function recheckNoChangeCI(input: {
  stage: IssueStageContext;
  codeHost: CodeHost;
  read: ReadOperation;
  repair: RepairProgress;
  failed: RequiredCheck[];
  pending: boolean;
}): Promise<"ready" | "wait" | "refresh"> {
  const { stage, codeHost, read, repair, failed, pending } = input;
  const { progress, operator, signal } = stage;
  const { repository, ticket } = progress;
  const pause = async (reason: string) => {
    await pauseForOperator(operator, reason, signal, true);
    return "refresh" as const;
  };
  const rerun = repair.actionsRerun;
  const runId =
    rerun?.runId ?? failed.find((check) => check.actionsRunId)?.actionsRunId;
  if (!rerun && (pending || failed.length === 0))
    return pending ? "wait" : "ready";
  if (!runId)
    return pause(
      "Cannot rerun failed required checks: no GitHub Actions run was identified.",
    );

  const query = { repository, runId };
  const target = `ticket:${ticket}`;
  const run = await read("observe_actions_run", target, () =>
    codeHost.observeActionsRun(query),
  );
  if (rerun) {
    if (run.attempt <= rerun.previousAttempt || run.status !== "completed")
      return "wait";
    if (run.conclusion !== "success")
      return pause(
        `GitHub Actions rerun ${runId} attempt ${run.attempt} failed (${run.conclusion}). Resolve the required checks.`,
      );
    if (failed.length === 0) return pending ? "wait" : "ready";
    if (pending || failed.some((check) => check.actionsRunId === runId))
      return "wait";
    return pause(
      `Required checks failed after GitHub Actions rerun ${runId}: ${failed.map(({ name }) => name).join(", ")}.`,
    );
  }

  const launch = run.status === "completed" && run.conclusion !== "success";
  repair.actionsRerun = {
    runId,
    previousAttempt: launch ? run.attempt : run.attempt - 1,
  };
  const publication = progress.publication!;
  publication.checksDeadline =
    stage.clock.now().getTime() +
    stage.loaded.config.timeouts.requiredChecksMinutes * 60_000;
  await stage.persist();
  if (!launch) return "wait";

  try {
    await read(
      "rerun_failed_actions_jobs",
      target,
      () => codeHost.rerunFailedJobs(query),
      { retry: "never" },
    );
  } catch (error) {
    signal?.throwIfAborted();
    return pause(
      `Cannot rerun failed jobs for GitHub Actions run ${runId}: ${error instanceof Error ? error.message : String(error)}.`,
    );
  }
  return "refresh";
}
