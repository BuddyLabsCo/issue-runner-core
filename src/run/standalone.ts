import { randomUUID } from "node:crypto";
import path from "node:path";
import type { LoadedProject } from "../config.ts";
import type { ImplementationProgress } from "../recovery.ts";
import { saveProgress } from "../recovery.ts";
import { implementIssue } from "../agent/implementation.ts";
import { verifyWorkspace } from "./verification.ts";
import {
  readHandoff,
  object,
  nonempty,
  parseExecution,
} from "../agent/handoff.ts";
import type { Ticket, Tracker } from "./contracts.ts";
import type { RunContext, RunSummary } from "./run.ts";

export async function runStandalone(input: {
  number: number;
  loaded: LoadedProject;
  tracker: Tracker;
  context: RunContext;
  summary: RunSummary;
  read: <T>(
    operation: string,
    target: string,
    action: () => Promise<T>,
  ) => Promise<T>;
}): Promise<RunSummary> {
  const { number, loaded, tracker, context, read, summary } = input;
  const config = loaded.config;
  const repository = config.repository;
  const accept = async (progress: ImplementationProgress, text: string) => {
    const result = parseExecution(text);
    const evidence = await read(
      "inspect_implementation",
      `ticket:${number}`,
      () => context.git.inspect(progress),
    );
    verifyWorkspace(progress, evidence, result);
    return result;
  };
  const progressFile = path.join(
    loaded.directory,
    "recovery",
    `${context.inputHash}-${number}.json`,
  );
  const persist = (progress: ImplementationProgress) =>
    read("save_implementation_checkpoint", `ticket:${number}`, () =>
      saveProgress(progressFile, progress),
    );
  const previous = await readHandoff(progressFile);
  let restored: ImplementationProgress | undefined;
  if (previous !== undefined) {
    const saved = object(JSON.parse(previous.text) as unknown);
    if (
      saved.project !== summary.project ||
      saved.ticket !== number ||
      saved.repository !== repository ||
      saved.target_branch !== summary.targetBranch ||
      !nonempty(saved.execution_id) ||
      !nonempty(saved.run_id) ||
      !nonempty(saved.worktree) ||
      !path.isAbsolute(saved.worktree) ||
      !nonempty(saved.branch) ||
      !nonempty(saved.base) ||
      !["implementing", "implementation_completed"].includes(
        String(saved.phase),
      )
    )
      throw new Error(
        "unable to recover: incomplete or invalid implementation checkpoint",
      );
    const roles = object(saved.roles);
    const implement = object(roles.implement);
    const invocation = object(saved.invocation);
    if (
      !nonempty(implement.sessionid) ||
      !nonempty(saved.pr_title) ||
      !nonempty(saved.pr_body) ||
      !nonempty(invocation.invocation_id) ||
      !nonempty(invocation.path) ||
      path.dirname(invocation.path) !==
        path.join(loaded.directory, "handoffs") ||
      !Number.isSafeInteger(saved.corrections) ||
      (saved.corrections as number) < 0 ||
      (saved.probeRetries !== undefined &&
        (!Number.isSafeInteger(saved.probeRetries) ||
          (saved.probeRetries as number) < 0)) ||
      !Array.isArray(saved.superseded)
    )
      throw new Error(
        "unable to recover: missing native implementation context",
      );
    restored = saved as unknown as ImplementationProgress;
  }
  const inspect = async (): Promise<{ ticket: Ticket; reason?: string }> => {
    const ticket = await read("read_issue", `ticket:${number}`, () =>
      tracker.getTicket(repository, number),
    );
    if (
      ticket.number !== number ||
      (ticket.repository !== undefined && ticket.repository !== repository)
    )
      throw new Error("Unexpected Issue ownership");
    if (ticket.state === "closed") {
      if (
        ticket.stateReason !== "completed" &&
        ticket.stateReason !== "not_planned"
      )
        throw new Error("closed Issue has no supported closure reason");
      return { ticket, reason: "Issue is already terminal" };
    }
    if (!ticket.labels?.includes("ready-for-agent"))
      return { ticket, reason: "Issue is missing ready-for-agent" };
    if (
      ticket.assignees?.some(
        (account) => account !== config.tracker.runnerAccount,
      )
    )
      return { ticket, reason: "Issue is externally owned" };
    const pages = new Set<number>();
    let page: number | null = 1;
    while (page !== null) {
      if (!Number.isSafeInteger(page) || page <= 0 || pages.has(page))
        throw new Error("invalid blocker pagination");
      pages.add(page);
      const currentPage: number = page;
      const current: Awaited<ReturnType<Tracker["listBlockersPage"]>> =
        await read("read_blockers", `ticket:${number}:page:${page}`, () =>
          tracker.listBlockersPage(repository, number, currentPage),
        );
      if (
        current.blockers.some(
          (blocker) =>
            blocker.state === "open" ||
            (blocker.stateReason !== "completed" &&
              blocker.stateReason !== "not_planned"),
        )
      )
        return { ticket, reason: "Issue is blocked" };
      page = current.nextPage;
    }
    return { ticket };
  };
  let selected = await inspect();
  if (selected.reason)
    return {
      ...summary,
      outcome: selected.ticket.state === "closed" ? "no_work" : "incomplete",
      reasons: [selected.reason],
    };
  const hasRunner =
    selected.ticket.assignees?.includes(config.tracker.runnerAccount) ?? false;
  const hasLabel =
    selected.ticket.labels?.includes(config.tracker.reservationLabel) ?? false;
  if (restored) {
    if (!hasRunner || !hasLabel)
      return {
        ...summary,
        reasons: ["Recorded Reservation changed before continuation"],
      };
    if (restored.phase === "implementation_completed") {
      const result = parseExecution(JSON.stringify(restored.result));
      verifyWorkspace(
        restored,
        await read("inspect_completed_implementation", `ticket:${number}`, () =>
          context.git.inspect(restored),
        ),
        result,
      );
    } else {
      const progress = restored;
      await implementIssue({
        loaded,
        ticket: selected.ticket,
        progress,
        persist: () => persist(progress),
        accept: (text) => accept(progress, text),
        closeTab: (close) =>
          read("close_implementation_tab", `ticket:${number}`, close),
        withEnvironment: (action) =>
          context.git.withAgentEnvironment(loaded.directory, action),
        terminal: context.terminal,
        clock: context.clock,
        operator: context.operator,
        ...(context.signal ? { signal: context.signal } : {}),
      });
    }
    return {
      ...summary,
      reasons: [
        "Implementation stage completed; Issue delivery remains incomplete",
      ],
    };
  }
  if (hasRunner || hasLabel)
    return {
      ...summary,
      reasons: [
        `existing Reservation${hasRunner !== hasLabel ? " (partial)" : ""}; no recorded ownership for this Run`,
      ],
    };
  // Confirm each write from current tracker state before retrying it.
  await read("add_reservation_label", `ticket:${number}`, async () => {
    const current = await tracker.getTicket(repository, number);
    if (!current.labels?.includes(config.tracker.reservationLabel))
      await tracker.addLabel(
        repository,
        number,
        config.tracker.reservationLabel,
      );
  });
  selected = await inspect();
  if (selected.reason) return { ...summary, reasons: [selected.reason] };
  await read("add_runner_assignee", `ticket:${number}`, async () => {
    const current = await tracker.getTicket(repository, number);
    if (!current.assignees?.includes(config.tracker.runnerAccount))
      await tracker.addAssignee(
        repository,
        number,
        config.tracker.runnerAccount,
      );
  });
  selected = await inspect();
  if (
    selected.reason ||
    !selected.ticket.assignees?.includes(config.tracker.runnerAccount) ||
    !selected.ticket.labels?.includes(config.tracker.reservationLabel)
  )
    return {
      ...summary,
      reasons: [selected.reason ?? "Reservation changed before dispatch"],
    };
  const executionId = randomUUID();
  const progress: ImplementationProgress = {
    run_id: context.runId,
    execution_id: executionId,
    project: summary.project,
    repository,
    ticket: number,
    target_branch: summary.targetBranch,
    worktree: path.join(
      loaded.directory,
      "worktrees",
      executionId,
      `ticket-${number}`,
    ),
    branch: `issue-runner/${context.runId}/ticket-${number}`,
    base: await read("fetch_target_branch", summary.targetBranch, () =>
      context.git.fetchTargetBranch(config.checkout, summary.targetBranch),
    ),
    phase: "reserved",
    roles: {},
    corrections: 0,
    superseded: [],
  };
  await persist(progress);
  context.signal?.throwIfAborted();
  await context.git.createWorktree({
    checkout: config.checkout,
    worktree: progress.worktree,
    branch: progress.branch,
    base: progress.base,
  });
  context.signal?.throwIfAborted();
  verifyWorkspace(
    progress,
    await read("inspect_fresh_worktree", `ticket:${number}`, () =>
      context.git.inspect(progress),
    ),
    {
      outcome: "no_change",
      summary: "Fresh Worktree",
      commits: [],
      findings_file: null,
    },
  );
  progress.phase = "worktree_created";
  await persist(progress);
  await implementIssue({
    loaded,
    ticket: selected.ticket,
    progress,
    persist: () => persist(progress),
    accept: (text) => accept(progress, text),
    closeTab: (close) =>
      read("close_implementation_tab", `ticket:${number}`, close),
    withEnvironment: (action) =>
      context.git.withAgentEnvironment(loaded.directory, action),
    terminal: context.terminal,
    clock: context.clock,
    operator: context.operator,
    ...(context.signal ? { signal: context.signal } : {}),
  });
  return {
    ...summary,
    reasons: [
      progress.result?.outcome === "no_change"
        ? "Implementation completed with no_change; no Issue delivery"
        : "Implementation stage completed; Review and publication are not implemented yet",
    ],
  };
}
