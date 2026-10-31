import { existsSync } from "node:fs";
import type { RunContext, RunSummary } from "./run.ts";
import type { runStandalone } from "./standalone.ts";
import { OperatorCancelled, TicketSkipped } from "./operations.ts";

export interface TicketReport {
  ticket: number;
  kind: "delivery" | "maintenance";
  status:
    | "completed"
    | "PR ready"
    | "no_change"
    | "no_work"
    | "incomplete"
    | "cancelled"
    | "failed";
  pullRequest: number | null;
  pullRequestUrl: string | null;
  detail: string;
  retainedWorktrees: string[];
}

export async function reportTicket(
  input: Parameters<typeof runStandalone>[0],
  execute: (input: Parameters<typeof runStandalone>[0]) => Promise<RunSummary>,
): Promise<RunSummary> {
  const report: TicketReport = {
    ticket: input.number,
    kind: input.documentation ? "maintenance" : "delivery",
    status: "incomplete",
    pullRequest: null,
    pullRequestUrl: null,
    detail: "Delivery remains incomplete",
    retainedWorktrees: [],
  };
  input.context.reports?.push(report);
  const capture = async (action: () => Promise<RunSummary>) => {
    let result: RunSummary | undefined;
    try {
      result = await action();
      report.status =
        result.outcome === "succeeded" ? "completed" : result.outcome;
      report.detail = result.reasons.join("; ");
      return result;
    } catch (error) {
      report.status =
        error instanceof TicketSkipped
          ? "incomplete"
          : error instanceof OperatorCancelled || input.context.signal?.aborted
            ? "cancelled"
            : "failed";
      report.detail = error instanceof Error ? error.message : String(error);
      throw error;
    } finally {
      const progress = [...(input.context.retained?.values() ?? [])].find(
        (saved) =>
          saved?.ticket === input.number &&
          (saved.purpose === "documentation") === Boolean(input.documentation),
      );
      const publication = progress?.publication;
      report.pullRequest = publication?.pullRequest?.number ?? null;
      report.pullRequestUrl = publication?.pullRequest?.url ?? null;
      const resources = progress
        ? [
            progress,
            ...(publication?.ciRepair?.attempts ?? []),
            ...(publication?.conflictRepair?.attempts ?? []),
          ]
        : [];
      report.retainedWorktrees = resources
        .map((resource) => resource.worktree)
        .filter(existsSync);
      if (progress?.result?.outcome === "no_change" && result)
        report.status = "no_change";
      else if (
        result?.outcome === "incomplete" &&
        publication?.phase === "checks_ready"
      )
        report.status = "PR ready";
    }
  };
  return capture(() =>
    execute({
      ...input,
      ...(input.deferIntegration
        ? {
            deferIntegration: (pullRequest, complete) =>
              input.deferIntegration!(pullRequest, () => capture(complete)),
          }
        : {}),
    }),
  );
}

export function reportRetained(context: RunContext, summary: RunSummary): void {
  for (const report of summary.tickets ?? [])
    report.retainedWorktrees = report.retainedWorktrees.filter(existsSync);
  for (const [snapshot, progress] of context.retained ?? []) {
    const repairs = [
      ...(progress?.publication?.ciRepair?.attempts ?? []),
      ...(progress?.publication?.conflictRepair?.attempts ?? []),
    ];
    const resources = progress ? [progress, ...repairs] : [];
    const stages = [
      ...resources,
      ...(progress?.reviews ?? []).flatMap((round) => [round, round.fix]),
    ];
    const paths = [
      snapshot,
      `${snapshot}.tmp`,
      ...resources.map((resource) => resource.worktree),
      ...stages.flatMap((stage) =>
        [
          stage?.probe?.path,
          stage?.invocation?.path,
          ...(stage?.superseded ?? []),
        ]
          .filter((file) => file !== undefined)
          .flatMap((file) => [file, `${file}.tmp`]),
      ),
      ...(progress?.reviews ?? []).flatMap((round) => [
        round.findings,
        `${round.findings}.tmp`,
      ]),
    ].filter(existsSync);
    if (paths.length === 0) continue;
    const report = progress
      ? `Retained Issue #${progress.ticket} execution=${progress.execution_id}; recorded branches: ${resources.map((resource) => resource.branch).join(", ")}; resources: ${paths.join(", ")}`
      : `Retained recovery evidence: ${paths.join(", ")}`;
    summary.reasons.push(report);
    if (summary.outcome === "failed" || summary.outcome === "cancelled")
      context.operator.write(report);
  }
}
