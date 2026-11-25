import { existsSync } from "node:fs";
import { nativeSession } from "../agent/native-identity.ts";
import type { ImplementationProgress } from "../recovery.ts";
import { recoverIssue } from "./execution-recovery.ts";
import { reportTicket, type TicketReport } from "./report.ts";
import type { RunSummary } from "./run.ts";
import type { runStandalone } from "./standalone.ts";

export async function runWithManualHandoff(
  input: Parameters<typeof runStandalone>[0],
  execute: (
    input: Parameters<typeof runStandalone>[0],
    report: TicketReport,
    restarting: boolean,
    handoff: ManualHandoff,
  ) => Promise<RunSummary>,
): Promise<RunSummary> {
  const handoff: ManualHandoff = {};
  try {
    return await reportTicket(input, (issue, report) =>
      recoverIssue(issue, async (attempt, restarting) => {
        delete handoff.progress;
        delete handoff.primaryTabOpen;
        try {
          return await execute(attempt, report, restarting, handoff);
        } catch (error) {
          if (
            error instanceof Error &&
            error.message.startsWith("unable to recover")
          )
            delete handoff.progress;
          throw error;
        }
      }),
    );
  } finally {
    if (!input.autoMerge) await reopenPrimaryTab(input, handoff);
  }
}

export interface ManualHandoff {
  progress?: ImplementationProgress;
  primaryTabOpen?: boolean;
}

export async function reopenPrimaryTab(
  input: Parameters<typeof runStandalone>[0],
  { progress, primaryTabOpen }: ManualHandoff,
): Promise<void> {
  if (!progress?.result || primaryTabOpen || !existsSync(progress.worktree))
    return;
  const { loaded, context } = input;
  const role = input.documentation ? "documentation" : "implement";
  const last = progress.reviews?.at(-1);
  if (
    !input.documentation &&
    loaded.config.workflow.review &&
    !progress.publication &&
    (progress.result.outcome === "no_change"
      ? progress.noChange?.review?.result?.outcome !== "passed"
      : last?.result?.outcome !== "passed" &&
        !(
          last &&
          last.round === loaded.config.workflow.maxReviewRounds &&
          last.fix?.result
        ))
  )
    return;
  const saved = progress.roles[role];
  const profile = loaded.config.agents[role];
  try {
    if (
      !saved ||
      !profile ||
      typeof saved.sessionid !== "string" ||
      !saved.sessionid.trim() ||
      [progress.execution_id, progress.run_id, "latest", "last"].includes(
        saved.sessionid,
      )
    )
      throw new Error("Missing native conversation identity");
    const expected = nativeSession(profile, saved.sessionid);
    if (saved.agent !== expected.agent || saved.resume !== expected.resume)
      throw new Error("Native conversation identity changed");
    const identity = await context.resumeManually(
      {
        cwd: progress.worktree,
        label: `issue-${input.number} ${role} (manual)`,
        submitKey: profile.submitKey ?? "Enter",
      },
      expected.resume,
    );
    if (identity !== undefined && identity !== saved.sessionid)
      throw new Error("Unexpected native conversation identity");
  } catch (error) {
    context.operator.write(
      `Unable to reopen ${role} tab: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}
