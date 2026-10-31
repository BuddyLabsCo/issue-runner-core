import { reportRetained, type TicketReport } from "./report.ts";
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
import type { ImplementationProgress } from "../recovery.ts";
import {
  boundedOperation,
  cancellableSleep,
  externalRead,
  serializeOperator,
  TicketSkipped,
  OperatorCancelled,
} from "./operations.ts";
import { runBatch } from "./batch.ts";
import { runStandalone } from "./standalone.ts";
import { runParent } from "./parent.ts";
import { runDocumentation } from "./documentation.ts";
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
  retained?: Map<string, ImplementationProgress | undefined>;
  reports?: TicketReport[];
}

export interface RunSummary {
  outcome: "succeeded" | "no_work" | "incomplete" | "cancelled" | "failed";
  project: string;
  parentTicket: number;
  targetBranch: string;
  reasons: string[];
  tickets?: TicketReport[];
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
  const retained = new Map<string, ImplementationProgress | undefined>();
  let summary: RunSummary = {
    outcome: "incomplete",
    project: options.project,
    parentTicket: options.parentTicket ?? options.issueTicket ?? 0,
    targetBranch: loaded.config.targetBranch ?? "unresolved",
    reasons: [],
    tickets: [],
  };
  try {
    return (summary = await executeProject(
      options,
      loaded,
      tracker,
      codeHost,
      {
        ...context,
        retained,
        reports: summary.tickets!,
      },
      summary,
    ));
  } catch (error) {
    summary.outcome =
      error instanceof OperatorCancelled || context.signal?.aborted
        ? "cancelled"
        : "failed";
    const reason = error instanceof Error ? error.message : String(error);
    summary.reasons.push(reason);
    context.operator.write(
      `Run ${summary.outcome}: ${reason.replace(/\s+/gu, " ").trim()}`,
    );
    return summary;
  } finally {
    reportRetained({ ...context, retained }, summary);
  }
}

async function executeProject(
  options: RunOptions,
  loaded: LoadedProject,
  tracker: Tracker,
  codeHost: CodeHost,
  context: RunContext,
  summary: RunSummary,
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
  const { clock, git, terminal } = context;
  context = {
    ...context,
    signal,
    operator,
    clock: {
      now: () => clock.now(),
      sleep: (ms) => cancellableSleep(clock, ms, signal),
    },
    git: {
      cleanupWorktree: (input) =>
        operator.advance(() => git.cleanupWorktree(input)),
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
  summary.targetBranch = targetBranch;
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
  const trigger = loaded.config.workflow.docMaintainTriggerLabel;
  if (
    options.selector === "issue" &&
    options.issueTicket !== undefined &&
    !trigger
  )
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
  let maintenancePending = false;
  const document = async (batch?: string, runId = context.runId) => {
    base = undefined;
    maintenancePending = Boolean(batch);
    const result = await runDocumentation({
      loaded,
      tracker,
      codeHost,
      context: { ...context, runId },
      summary,
      read,
      fetchBase,
      autoMerge: options.autoMerge,
      ...(batch ? { batch } : {}),
    });
    maintenancePending &&= result.outcome !== "succeeded";
    return result;
  };
  if (options.selector === "document") return document();
  const selectBatch = (tickets: Ticket[]) =>
    selectIssueBatch({
      tickets,
      loaded,
      tracker,
      context,
      read,
      targetBranch,
      ...(options.issueTicket !== undefined
        ? { issueTicket: options.issueTicket }
        : {}),
    });
  const batch = (
    tickets: Ticket[],
    selection?: Awaited<ReturnType<typeof selectBatch>>,
  ) => {
    base = undefined;
    return runBatch({
      tickets,
      ...(selection ? { selection } : {}),
      loaded,
      tracker,
      context,
      read,
      summary,
      codeHost,
      fetchBase,
      autoMerge: options.autoMerge,
      options,
      controller,
      document,
    });
  };
  const readTicket = async (number: number) => {
    const ticket = await read("read_issue", `ticket:${number}`, () =>
      tracker.getTicket(loaded.config.repository, number),
    );
    if (
      ticket.number !== number ||
      (ticket.repository !== undefined &&
        ticket.repository !== loaded.config.repository)
    )
      throw new Error("Unexpected Issue ownership");
    return ticket;
  };
  const recoveredReasons: string[] = [];
  const pending = await selectBatch([]);
  if (pending.batch.length > 0) {
    const result = await batch(
      pending.documentation
        ? []
        : await Promise.all(pending.batch.map(readTicket)),
      pending,
    );
    if (result.outcome !== "succeeded" || options.issueTicket !== undefined)
      return result;
    recoveredReasons.push(...result.reasons);
  }
  if (options.selector === "parent") {
    const result = await runParent({
      repository: loaded.config.repository,
      parentTicket: summary.parentTicket,
      tracker,
      read,
      summary,
      runBatch: batch,
      maintenancePending: () => maintenancePending,
    });
    return { ...result, reasons: [...recoveredReasons, ...result.reasons] };
  }
  const tickets: Ticket[] = [];
  for (const number of options.issueTicket !== undefined
    ? [options.issueTicket]
    : loaded.config.issueList) {
    tickets.push(await readTicket(number));
  }
  const result = await batch(tickets);
  return {
    ...result,
    outcome:
      recoveredReasons.length > 0 && result.outcome === "no_work"
        ? "succeeded"
        : result.outcome,
    reasons: [...recoveredReasons, ...result.reasons],
  };
}
