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
  pullRequestTitle: string | null;
  detail: string;
  retainedWorktrees: string[];
}

export interface RetainedEvidence {
  ticket?: number;
  executionId?: string;
  recordedBranches: string[];
  worktrees: string[];
  paths: string[];
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
    pullRequestTitle: null,
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
      report.pullRequestTitle = publication?.pullRequest
        ? publication.title
        : null;
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
    (summary.retainedEvidence ??= []).push({
      ...(progress
        ? { ticket: progress.ticket, executionId: progress.execution_id }
        : {}),
      recordedBranches: resources.map((resource) => resource.branch),
      worktrees: resources
        .map((resource) => resource.worktree)
        .filter(existsSync),
      paths: paths.filter(
        (file) => !resources.some((resource) => resource.worktree === file),
      ),
    });
  }
}

function oneLine(value: string): string {
  return value.replace(/\s+/gu, " ").trim();
}

// Align the visible PR text before wrapping it in an OSC 8 hyperlink.
function hyperlink(target: string, text: string): string {
  return `\u001b]8;;${target}\u001b\\${text}\u001b]8;;\u001b\\`;
}

function pullRequestCell(ticket: TicketReport): {
  text: string;
  target?: string;
} {
  if (ticket.pullRequest === null) return { text: "-" };
  return {
    text: `#${ticket.pullRequest}`,
    ...(ticket.pullRequestUrl === null
      ? {}
      : { target: ticket.pullRequestUrl }),
  };
}

function table(tickets: TicketReport[]): string[] {
  const rows = tickets.map((ticket) => {
    const pullRequest = pullRequestCell(ticket);
    const detail = oneLine(ticket.pullRequestTitle ?? ticket.detail);
    return {
      cells: [
        String(ticket.ticket),
        ticket.status,
        pullRequest.text,
        ticket.kind === "maintenance" && ticket.pullRequest === null
          ? `Documentation: ${detail}`
          : detail,
      ] as const,
      pullRequestTarget: pullRequest.target,
    };
  });
  const headings = ["Issue", "Status", "PR", "Detail"];
  const widths = headings.map((heading, column) =>
    Math.max(heading.length, ...rows.map((row) => row.cells[column]!.length)),
  );
  const render = (cells: readonly string[], target?: string) =>
    cells
      .map((value, column) => {
        const padded =
          column === cells.length - 1 ? value : value.padEnd(widths[column]!);
        return column === 2 && target !== undefined
          ? hyperlink(target, padded)
          : padded;
      })
      .join("  ");
  return [
    render(headings),
    render(widths.map((width) => "-".repeat(width))),
    ...rows.map((row) => render(row.cells, row.pullRequestTarget)),
  ];
}

export function renderRunReport(summary: RunSummary): string {
  const tickets = summary.tickets ?? [];
  const lines =
    tickets.length === 0 ? ["No issues processed."] : table(tickets);
  const reported = new Set(
    tickets.flatMap((ticket) =>
      ticket.pullRequestTitle &&
      ["failed", "cancelled", "incomplete"].includes(ticket.status)
        ? []
        : [ticket.detail, `Issue #${ticket.ticket}: ${ticket.detail}`],
    ),
  );
  if (summary.outcome === "failed") {
    lines.push(
      "",
      "Run failed:",
      ...(summary.failure ?? "Unknown failure")
        .split("\n")
        .filter((line) => line.trim())
        .map((line) => `- ${line}`),
    );
    reported.add(summary.failure ?? "Unknown failure");
  }
  const reasons = [...new Set(summary.reasons)].filter(
    (reason) =>
      !reported.has(reason) &&
      !/^(?:selected Delivery Tickets:|Retained |Completed Maintenance Ticket )/u.test(
        reason,
      ),
  );
  if (reasons.length > 0)
    lines.push(
      "",
      "Reasons:",
      ...reasons.map((reason) => `- ${oneLine(reason)}`),
    );
  const evidence = summary.retainedEvidence ?? [];
  const worktrees = [
    ...new Set([
      ...tickets.flatMap((ticket) => ticket.retainedWorktrees),
      ...evidence.flatMap((entry) => entry.worktrees),
    ]),
  ];
  if (worktrees.length > 0)
    lines.push(
      "",
      "Retained Worktrees:",
      ...worktrees.map((file) => `- ${file}`),
    );
  if (summary.outcome === "cancelled") lines.push("", "Run cancelled.");
  return lines.join("\n");
}
