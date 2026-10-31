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
import {
  boundedOperation,
  externalRead,
  serializeOperator,
  TicketSkipped,
} from "./operations.ts";
import { integrateBatch } from "./integration.ts";
import { runStandalone } from "./standalone.ts";
import { runParent } from "./parent.ts";
import { selectIssueBatch, type ReadOperation } from "./discovery.ts";

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
  const operator = serializeOperator(context.operator, controller, signal);
  const host = codeHost;
  codeHost = {
    resolveTargetBranch: (repository) => host.resolveTargetBranch(repository),
    getRemoteBranchHead: (repository, branch) =>
      host.getRemoteBranchHead(repository, branch),
    listPullRequests: (repository) => host.listPullRequests(repository),
    getRequiredChecks: (repository, pullRequest) =>
      host.getRequiredChecks(repository, pullRequest),
    createPullRequest: (input) =>
      operator.advance(() => host.createPullRequest(input)),
    getPullRequest: (repository, pullRequest) =>
      host.getPullRequest(repository, pullRequest),
    requestSquashMerge: (input) =>
      operator.advance(() => host.requestSquashMerge(input)),
  };
  const { git, terminal } = context;
  context = {
    ...context,
    signal,
    operator,
    git: {
      push: (worktree, branch, headSha) =>
        operator.advance(() => git.push(worktree, branch, headSha)),
      fetchTargetBranch: (checkout, branch) =>
        git.fetchTargetBranch(checkout, branch),
      inspect: (input) => git.inspect(input),
      createWorktree: (input) =>
        operator.advance(() => git.createWorktree(input)),
      withAgentEnvironment: (directory, action) =>
        operator.advance(() => git.withAgentEnvironment(directory, action)),
    },
    terminal: {
      createTab: (options) =>
        operator.advance(() =>
          boundedOperation(
            () => terminal.createTab(options),
            `terminal createTab ${options.label}`,
            signal,
          ),
        ),
      submitText: (tab, text, chord) =>
        operator.advance(() =>
          boundedOperation(
            () => terminal.submitText(tab, text, chord),
            "terminal submitText; delivery is uncertain",
            signal,
          ),
        ),
      closeTab: (tab) =>
        operator.advance(() =>
          boundedOperation(
            () => terminal.closeTab(tab),
            "terminal closeTab; cleanup is unresolved",
            signal,
          ),
        ),
    },
  };
  const read: ReadOperation = (operation, target, action, settings) =>
    externalRead({
      ...context,
      ...settings,
      action: () => operator.advance(action),
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
  const attemptIssue = async (input: Parameters<typeof runStandalone>[0]) => {
    try {
      return await runStandalone(input);
    } catch (error) {
      if (error instanceof TicketSkipped)
        return { ...summary, reasons: [error.message] };
      throw error;
    }
  };
  if (options.selector === "issue" && options.issueTicket !== undefined)
    return attemptIssue({
      number: options.issueTicket,
      loaded,
      tracker,
      context,
      summary,
      read,
      fetchBase,
      codeHost,
      autoMerge: options.autoMerge,
    });
  if (options.selector === "document") {
    return {
      ...summary,
      reasons: [`${options.selector} delivery is not implemented yet`],
    };
  }
  const runBatch = async (tickets: Ticket[]): Promise<RunSummary> => {
    base = undefined;
    const selection = await selectIssueBatch({
      tickets,
      loaded,
      tracker,
      context,
      read,
      targetBranch,
    });
    const reasons = [...selection.reasons];
    const integrations = new Map<
      number,
      { pullRequest: number; complete: () => Promise<RunSummary> }
    >();
    let delivered: number[] = [];
    let resolved: boolean;
    const attempts = selection.batch.map(async (number) => {
      try {
        signal.throwIfAborted();
        return await attemptIssue({
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
          codeHost,
          autoMerge: options.autoMerge,
          deferIntegration: (pullRequest, complete) => {
            integrations.set(number, { pullRequest, complete });
          },
        });
      } catch (error) {
        controller.abort(error);
        throw error;
      }
    });
    try {
      const results = await integrateBatch({
        batch: selection.batch,
        ready: integrations,
        results: await Promise.all(attempts),
        repository: loaded.config.repository,
        codeHost,
        read,
      });
      resolved = results.every(
        (result) =>
          result.outcome === "succeeded" || result.outcome === "no_work",
      );
      if (
        selection.batch.length > 0 &&
        resolved &&
        options.selector === "parent"
      )
        await selection.complete();
      delivered = selection.batch.filter(
        (_number, index) => results[index]!.outcome === "succeeded",
      );
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
        (selection.batch.length === 0 && tickets.length === 0) ||
        (options.selector === "issue" &&
          tickets.every((ticket) => ticket.state === "closed"))
          ? "no_work"
          : (options.selector === "parent" &&
                selection.batch.length > 0 &&
                resolved) ||
              (options.selector === "issue" &&
                tickets.every(
                  (ticket) =>
                    ticket.state === "closed" ||
                    delivered.includes(ticket.number),
                ))
            ? "succeeded"
            : "incomplete",
      reasons: [
        ...(selection.batch.length
          ? [`selected Delivery Tickets: ${selection.batch.join(", ")}`]
          : []),
        ...reasons,
      ],
    };
  };
  if (options.selector === "parent")
    return runParent({
      repository: loaded.config.repository,
      parentTicket: summary.parentTicket,
      tracker,
      read,
      summary,
      runBatch,
    });
  const tickets: Ticket[] = [];
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
  return runBatch(tickets);
}
