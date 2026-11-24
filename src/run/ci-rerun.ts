import type { RepairProgress } from "../recovery.ts";
import {
  ActionsRerunRejected,
  type CodeHost,
  type RequiredCheck,
} from "./contracts.ts";
import type { ReadOperation } from "./discovery.ts";
import { pauseForOperator } from "./operations.ts";
import type { IssueStageContext } from "../agent/stage.ts";
import type { RunContext } from "./run.ts";

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
    actionsRerun.previousAttempt >= 0 &&
    (actionsRerun.retryable === undefined || actionsRerun.retryable === true) &&
    (actionsRerun.failureAcknowledged === undefined ||
      (actionsRerun.failureAcknowledged === true && !actionsRerun.retryable))
  );
}

interface RecheckInput {
  stage: IssueStageContext;
  codeHost: CodeHost;
  read: ReadOperation;
  repair: RepairProgress;
  failed: RequiredCheck[];
  pending: boolean;
  checksDeadline: () => number;
  advance: RunContext["advance"];
  persistDispatch: () => Promise<void>;
}

export async function recheckNoChangeCI(
  input: RecheckInput,
): Promise<"ready" | "wait" | "refresh"> {
  const { stage, codeHost, read, repair, failed, pending } = input;
  const { progress, operator, signal } = stage;
  const { repository, ticket } = progress;
  const pause = async (reason: string) => {
    await pauseForOperator(operator, reason, signal, true);
    return "refresh" as const;
  };
  const saved = repair.actionsRerun;
  const rerun =
    saved?.retryable &&
    !failed.some((check) => check.actionsRunId === saved.runId)
      ? undefined
      : saved;
  const runId =
    rerun?.runId ?? failed.find((check) => check.actionsRunId)?.actionsRunId;
  if ((!rerun || rerun.retryable) && (pending || failed.length === 0))
    return pending ? "wait" : "ready";
  if (rerun?.failureAcknowledged && (pending || failed.length === 0))
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
  if (rerun?.retryable && run.attempt > rerun.previousAttempt) {
    delete rerun.retryable;
    await stage.persist();
  }
  if (rerun && (!rerun.retryable || run.attempt < rerun.previousAttempt)) {
    if (run.attempt <= rerun.previousAttempt || run.status !== "completed")
      return "wait";
    if (run.conclusion !== "success") {
      await pause(
        `GitHub Actions rerun ${runId} attempt ${run.attempt} failed (${run.conclusion}). Resolve the required checks.`,
      );
      rerun.failureAcknowledged = true;
      await stage.persist();
      return "refresh";
    }
    if (failed.length === 0) return pending ? "wait" : "ready";
    if (pending || failed.some((check) => check.actionsRunId === runId))
      return "wait";
    return pause(
      `Required checks failed after GitHub Actions rerun ${runId}: ${failed.map(({ name }) => name).join(", ")}.`,
    );
  }

  const launch = run.status === "completed" && run.conclusion !== "success";
  const checkpoint = {
    runId,
    previousAttempt: launch ? run.attempt : run.attempt - 1,
  };
  if (!launch) {
    await saveRerun(input, checkpoint);
    return "wait";
  }
  try {
    await read(
      "rerun_failed_actions_jobs",
      target,
      () => dispatchRerun(input, checkpoint),
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

type RerunCheckpoint = NonNullable<RepairProgress["actionsRerun"]>;

async function saveRerun(
  input: RecheckInput,
  checkpoint: RerunCheckpoint,
): Promise<void> {
  input.repair.actionsRerun = checkpoint;
  input.stage.progress.publication!.checksStartedAt = input.stage.clock
    .now()
    .getTime();
  input.stage.progress.publication!.checksDeadline = input.checksDeadline();
  await input.stage.persist();
}

async function dispatchRerun(
  input: RecheckInput,
  checkpoint: RerunCheckpoint,
): Promise<void> {
  const { stage, codeHost, advance } = input;
  let dispatched = false;
  const dispatch = async () => {
    delete checkpoint.retryable;
    await input.persistDispatch();
    stage.signal?.throwIfAborted();
    dispatched = true;
    return codeHost.rerunFailedJobs({
      repository: stage.progress.repository,
      runId: checkpoint.runId,
    });
  };
  try {
    checkpoint.retryable = true;
    await saveRerun(input, checkpoint);
    await (advance ? advance(dispatch) : dispatch());
  } catch (error) {
    if (!dispatched || error instanceof ActionsRerunRejected) {
      checkpoint.retryable = true;
      await stage.persist();
    }
    throw error;
  }
}
