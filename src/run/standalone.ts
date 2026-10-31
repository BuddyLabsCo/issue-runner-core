import { randomUUID } from "node:crypto";
import path from "node:path";
import { readFile } from "node:fs/promises";
import type { LoadedProject } from "../config.ts";
import type { ImplementationProgress } from "../recovery.ts";
import { saveProgress } from "../recovery.ts";
import { runIssueStage, type IssueStageContext } from "../agent/stage.ts";
import { implementationInstructions } from "../prompts/implement.ts";
import {
  reviewImplementation,
  validateReviewContext,
  verifiedImplementation,
} from "./review.ts";
import { verifyWorkspace } from "./verification.ts";
import {
  readHandoff,
  object,
  nonempty,
  parseExecution,
} from "../agent/handoff.ts";
import type { Ticket, Tracker } from "./contracts.ts";
import type { RunContext, RunSummary } from "./run.ts";
import {
  hasOpenBlocker,
  readChildren,
  type ReadOperation,
} from "./discovery.ts";
import { OperatorCancelled, scopeOperator } from "./operations.ts";

export async function runStandalone(input: {
  number: number;
  parentTicket?: number;
  loaded: LoadedProject;
  tracker: Tracker;
  context: RunContext;
  summary: RunSummary;
  read: ReadOperation;
  fetchBase: () => Promise<string>;
}): Promise<RunSummary> {
  const { number, loaded, tracker, summary } = input;
  const context = {
    ...input.context,
    operator: scopeOperator(input.context.operator, `Issue #${number}`),
  };
  const read: ReadOperation = (operation, target, action, settings) =>
    input.read(operation, target, action, {
      operator: context.operator,
      ...settings,
    });
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
  // Cancellation must still retain known unsent work in the local checkpoint.
  const persist = (progress: ImplementationProgress) =>
    context.signal?.aborted
      ? saveProgress(progressFile, progress)
      : read("save_implementation_checkpoint", `ticket:${number}`, () =>
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
      (saved.phase !== "implementing" && saved.result === undefined) ||
      ![
        "implementing",
        "implementation_completed",
        "reviewing",
        "review_completed",
        "fixing_review",
        "fix_review_completed",
        "publication_eligible",
      ].includes(String(saved.phase))
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
      (saved.probeIds !== undefined &&
        (!Array.isArray(saved.probeIds) || !saved.probeIds.every(nonempty))) ||
      (saved.pendingPrompt !== undefined && !nonempty(saved.pendingPrompt)) ||
      !Array.isArray(saved.superseded)
    )
      throw new Error(
        "unable to recover: missing native implementation context",
      );
    restored = saved as unknown as ImplementationProgress;
    validateReviewContext(restored, loaded);
  }
  const inspect = async (): Promise<{ ticket: Ticket; reason?: string }> => {
    if (input.parentTicket !== undefined) {
      const parent = await read(
        "read_parent",
        `parent:${input.parentTicket}`,
        () => tracker.getParent(repository, input.parentTicket!),
      );
      if (parent.state === "closed") {
        if (parent.stateReason === "not_planned")
          throw new OperatorCancelled("Parent Ticket is cancelled");
        throw new Error("Parent Ticket changed to a terminal state");
      }
      const children = await readChildren(
        repository,
        input.parentTicket,
        tracker,
        read,
      );
      if (!children.some((child) => child.number === number))
        return {
          ticket: { number, state: "open", stateReason: null },
          reason: "Issue left Parent scope",
        };
    }
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
    if (await hasOpenBlocker(repository, number, tracker, read))
      return { ticket, reason: "Issue is blocked" };
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
  const beforeDispatch = async () => {
    selected = await inspect();
    if (
      !selected.reason &&
      (!selected.ticket.assignees?.includes(config.tracker.runnerAccount) ||
        !selected.ticket.labels?.includes(config.tracker.reservationLabel))
    )
      selected.reason = "Reservation changed before dispatch";
    return selected.reason === undefined;
  };
  const execute = async (progress: ImplementationProgress) => {
    const stageInput: IssueStageContext = {
      loaded,
      progress,
      ticket: selected.ticket,
      persist: () => persist(progress),
      beforeDispatch,
      closeTab: (close) =>
        read(
          `close_${progress.phase.replace("_completed", "")}_tab`,
          `ticket:${number}`,
          close,
        ),
      withEnvironment: (action) =>
        context.git.withAgentEnvironment(loaded.directory, action),
      terminal: {
        createTab: (options) =>
          read(
            "create_tab",
            options.label,
            () => context.terminal.createTab(options),
            { retry: "manual" },
          ),
        submitText: (tab, text, chord) =>
          read(
            "submit_text",
            `ticket:${number}:${progress.phase}`,
            () => context.terminal.submitText(tab, text, chord),
            { retry: "never" },
          ),
        closeTab: (tab) => context.terminal.closeTab(tab),
      },
      clock: context.clock,
      operator: context.operator,
      ...(context.signal ? { signal: context.signal } : {}),
    };
    if (progress.result) {
      if (
        [
          "implementation_completed",
          "review_completed",
          "fix_review_completed",
          "publication_eligible",
        ].includes(progress.phase)
      )
        verifyWorkspace(
          progress,
          await read(
            "inspect_completed_implementation",
            `ticket:${number}`,
            () => context.git.inspect(progress),
          ),
          parseExecution(JSON.stringify(verifiedImplementation(progress))),
        );
    } else {
      await runIssueStage({
        ...stageInput,
        stage: progress,
        purpose: "implement",
        task: async () =>
          `${implementationInstructions}\n\n${await readFile(path.join(loaded.directory, "prompts", "implement.md"), "utf8")}\n\n` +
          `Repository: ${repository}\nIssue #${number}: ${selected.ticket.title ?? ""}\n${selected.ticket.body ?? ""}\n` +
          `Worktree: ${progress.worktree}\nDelivery branch: ${progress.branch}\nBase SHA: ${progress.base}\nTarget Branch: ${progress.target_branch}`,
        accept: (text) => accept(progress, text),
      });
    }
    if (progress.result?.outcome === "committed" && config.workflow.review)
      await reviewImplementation({
        ...stageInput,
        ticket: selected.ticket,
        git: context.git,
        read,
      });
    return {
      ...summary,
      reasons: [
        selected.reason ??
          (progress.phase === "publication_eligible" ||
          (progress.result?.outcome === "committed" && !config.workflow.review)
            ? "Implementation stage completed and is eligible for publication; publication is not implemented yet"
            : progress.result?.outcome === "no_change"
              ? "Implementation completed with no_change; no Issue delivery"
              : "Implementation stage completed; Issue delivery remains incomplete"),
      ],
    };
  };
  if (restored) {
    if (!hasRunner || !hasLabel)
      return {
        ...summary,
        reasons: ["Recorded Reservation changed before continuation"],
      };
    return execute(restored);
  }
  if (hasRunner || hasLabel)
    return {
      ...summary,
      reasons: [
        `existing Reservation${hasRunner !== hasLabel ? " (partial)" : ""}; no recorded ownership for this Run`,
      ],
    };
  // Confirm each write from current tracker state before retrying it.
  await read(
    "add_reservation_label",
    `ticket:${number}`,
    async () => {
      selected = await inspect();
      if (selected.reason) return;
      if (selected.ticket.assignees?.includes(config.tracker.runnerAccount)) {
        selected.reason = "Reservation changed before label";
        return;
      }
      if (!selected.ticket.labels?.includes(config.tracker.reservationLabel))
        await tracker.addLabel(
          repository,
          number,
          config.tracker.reservationLabel,
        );
    },
    {
      reconcile: async () => {
        selected = await inspect();
        return selected.ticket.labels?.includes(config.tracker.reservationLabel)
          ? { outcome: "completed", result: undefined }
          : { outcome: "pending" };
      },
    },
  );
  if (selected.reason) return { ...summary, reasons: [selected.reason] };
  await read(
    "add_runner_assignee",
    `ticket:${number}`,
    async () => {
      selected = await inspect();
      if (selected.reason) return;
      if (!selected.ticket.labels?.includes(config.tracker.reservationLabel)) {
        selected.reason = "Reservation changed before assignment";
        return;
      }
      if (!selected.ticket.assignees?.includes(config.tracker.runnerAccount))
        await tracker.addAssignee(
          repository,
          number,
          config.tracker.runnerAccount,
        );
    },
    {
      reconcile: async () => {
        selected = await inspect();
        return selected.ticket.assignees?.includes(config.tracker.runnerAccount)
          ? { outcome: "completed", result: undefined }
          : { outcome: "pending" };
      },
    },
  );
  if (selected.reason) return { ...summary, reasons: [selected.reason] };
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
    base: await input.fetchBase(),
    phase: "reserved",
    roles: {},
    corrections: 0,
    superseded: [],
  };
  await persist(progress);
  context.signal?.throwIfAborted();
  await read(
    "create_worktree",
    progress.worktree,
    () =>
      context.git.createWorktree({
        checkout: config.checkout,
        worktree: progress.worktree,
        branch: progress.branch,
        base: progress.base,
      }),
    { retry: "manual" },
  );
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
  return execute(progress);
}
