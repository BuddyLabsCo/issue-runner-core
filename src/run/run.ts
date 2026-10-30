import type { LoadedProject } from "../config.ts";
import type {
  Tracker,
  CodeHost,
  Clock,
  OperatorIO,
  GitWorkspace,
} from "./contracts.ts";
import type { TerminalPlugin } from "../terminal.ts";
import type { AuditLog } from "../audit.ts";
import { externalRead } from "./operations.ts";
import { runStandalone } from "./standalone.ts";
import { readChildren, selectParentBatch } from "./discovery.ts";

export interface RunContext {
  audit: AuditLog;
  runId: string;
  inputHash: string;
  clock: Clock;
  operator: OperatorIO;
  git: GitWorkspace;
  terminal: TerminalPlugin;
  signal?: AbortSignal;
}

export interface RunSummary {
  outcome: "succeeded" | "no_work" | "incomplete" | "cancelled" | "failed";
  project: string;
  parentTicket: number;
  targetBranch: string;
  reasons: string[];
}

export interface RunOptions {
  project: string;
  environment: string;
  selector: "parent" | "issue" | "document";
  parentTicket?: number;
  issueTicket?: number;
  autoMerge: boolean;
}

export async function runProject(
  options: RunOptions,
  loaded: LoadedProject,
  tracker: Tracker,
  codeHost: CodeHost,
  context: RunContext,
): Promise<RunSummary> {
  const read = <T>(
    operation: string,
    target: string,
    action: () => Promise<T>,
  ) =>
    externalRead({
      ...context,
      action,
      retryPolicy: loaded.config,
      event: (attempt) => ({
        timestamp: context.clock.now().toISOString(),
        runId: context.runId,
        project: options.project,
        parentTicket: options.parentTicket ?? 0,
        phase: "discover",
        operation,
        target,
        attempt,
      }),
    });
  context.signal?.throwIfAborted();
  const targetBranch =
    loaded.config.targetBranch ??
    (await read("resolve_target_branch", loaded.config.repository, () =>
      codeHost.resolveTargetBranch(loaded.config.repository),
    ));
  if (!targetBranch.trim()) throw new Error("Target Branch must not be empty");
  const summary: RunSummary = {
    outcome: "incomplete",
    project: options.project,
    parentTicket: options.parentTicket ?? options.issueTicket ?? 0,
    targetBranch,
    reasons: [],
  };
  if (options.selector === "issue" && options.issueTicket !== undefined)
    return runStandalone({
      number: options.issueTicket,
      loaded,
      tracker,
      context,
      summary,
      read,
    });
  if (options.selector !== "parent") {
    return {
      ...summary,
      reasons: [`${options.selector} delivery is not implemented yet`],
    };
  }
  const parent = await read(
    "read_parent",
    `parent:${summary.parentTicket}`,
    () => tracker.getParent(loaded.config.repository, summary.parentTicket),
  );
  if (parent.state === "closed" && parent.stateReason === "not_planned")
    return {
      ...summary,
      outcome: "cancelled",
      reasons: ["Parent Ticket is cancelled"],
    };
  if (parent.state === "closed" && parent.stateReason === null)
    throw new Error("closed Parent Ticket has no supported closure reason");
  const children = await readChildren(
    loaded.config.repository,
    summary.parentTicket,
    tracker,
    read,
  );
  if (parent.state === "closed") {
    if (children.some((child) => child.state === "open"))
      throw new Error("completed Parent Ticket has open children");
    return { ...summary, outcome: "succeeded" };
  }
  if (children.length > 0) {
    const selection = await selectParentBatch({
      children,
      loaded,
      tracker,
      context,
      read,
    });
    const reasons = [...selection.reasons];
    for (const child of selection.batch) {
      context.signal?.throwIfAborted();
      const result = await runStandalone({
        number: child.number,
        parentTicket: summary.parentTicket,
        loaded,
        tracker,
        context,
        summary,
        read,
      });
      reasons.push(
        ...result.reasons.map((reason) => `Issue #${child.number}: ${reason}`),
      );
    }
    return {
      ...summary,
      reasons: [
        ...(selection.batch.length
          ? [
              `selected Delivery Tickets: ${selection.batch.map((child) => child.number).join(", ")}`,
            ]
          : []),
        ...reasons,
      ],
    };
  }
  return {
    ...summary,
    outcome: "no_work",
    reasons: loaded.config.issueList.length
      ? [
          `configured Delivery Tickets not found: ${loaded.config.issueList.join(", ")}`,
        ]
      : [],
  };
}
