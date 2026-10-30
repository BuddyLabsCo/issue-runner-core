import type { LoadedProject } from "../config.ts";
import type {
  Tracker,
  CodeHost,
  Clock,
  OperatorIO,
  GitWorkspace,
  Ticket,
} from "./contracts.ts";
import type { TerminalPlugin } from "../terminal.ts";
import type { AuditLog } from "../audit.ts";
import { externalRead, serializeOperator } from "./operations.ts";
import { runStandalone } from "./standalone.ts";
import { readChildren, selectIssueBatch } from "./discovery.ts";

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
  const controller = new AbortController();
  const signal = context.signal
    ? AbortSignal.any([context.signal, controller.signal])
    : controller.signal;
  context = {
    ...context,
    signal,
    operator: serializeOperator(context.operator, controller, signal),
  };
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
  let base: Promise<string> | undefined;
  const fetchBase = () =>
    (base ??= read("fetch_target_branch", targetBranch, () =>
      context.git.fetchTargetBranch(loaded.config.checkout, targetBranch),
    ));
  if (options.selector === "issue" && options.issueTicket !== undefined)
    return runStandalone({
      number: options.issueTicket,
      loaded,
      tracker,
      context,
      summary,
      read,
      fetchBase,
    });
  if (options.selector === "document") {
    return {
      ...summary,
      reasons: [`${options.selector} delivery is not implemented yet`],
    };
  }
  let tickets: Ticket[];
  if (options.selector === "issue") {
    tickets = [];
    for (const number of loaded.config.issueList) {
      const ticket = await read("read_issue", `ticket:${number}`, () =>
        tracker.getTicket(loaded.config.repository, number),
      );
      if (
        ticket.number !== number ||
        (ticket.repository !== undefined &&
          ticket.repository !== loaded.config.repository)
      )
        throw new Error("Unexpected Issue ownership");
      tickets.push(ticket);
    }
  } else {
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
    tickets = await readChildren(
      loaded.config.repository,
      summary.parentTicket,
      tracker,
      read,
    );
    if (parent.state === "closed") {
      if (tickets.some((ticket) => ticket.state === "open"))
        throw new Error("completed Parent Ticket has open children");
      return { ...summary, outcome: "succeeded" };
    }
  }
  const selection = await selectIssueBatch({
    tickets,
    loaded,
    tracker,
    context,
    read,
    targetBranch,
  });
  const reasons = [...selection.reasons];
  const attempts = selection.batch.map(async (number) => {
    try {
      signal.throwIfAborted();
      return await runStandalone({
        number,
        ...(options.selector === "parent"
          ? { parentTicket: summary.parentTicket }
          : {}),
        loaded,
        tracker,
        context: { ...context, runId: selection.runId },
        summary,
        read,
        fetchBase,
      });
    } catch (error) {
      controller.abort(error);
      throw error;
    }
  });
  try {
    const results = await Promise.all(attempts);
    for (const [index, result] of results.entries())
      reasons.push(
        ...result.reasons.map(
          (reason) => `Issue #${selection.batch[index]!}: ${reason}`,
        ),
      );
  } catch (error) {
    await Promise.allSettled(attempts);
    throw error;
  }
  return {
    ...summary,
    outcome:
      selection.batch.length === 0 &&
      (tickets.length === 0 ||
        (options.selector === "issue" &&
          tickets.every((ticket) => ticket.state === "closed")))
        ? "no_work"
        : "incomplete",
    reasons: [
      ...(selection.batch.length
        ? [`selected Delivery Tickets: ${selection.batch.join(", ")}`]
        : []),
      ...reasons,
    ],
  };
}
