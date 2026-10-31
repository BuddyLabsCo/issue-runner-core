import { randomUUID } from "node:crypto";
import path from "node:path";
import { readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import type { LoadedProject } from "../config.ts";
import {
  closeDocumentationNoChange,
  integrateImplementation,
} from "./integration.ts";
import { saveProgress, type ImplementationProgress } from "../recovery.ts";
import { runIssueStage, type IssueStageContext } from "../agent/stage.ts";
import { implementationInstructions } from "../prompts/implement.ts";
import { documentationInstructions } from "../prompts/documentation.ts";
import { reviewImplementation, verifiedImplementation } from "./review.ts";
import { verifyWorkspace } from "./verification.ts";
import { parseExecution } from "../agent/handoff.ts";
import type { CodeHost, Ticket, Tracker } from "./contracts.ts";
import { publishImplementation } from "./publication.ts";
import { restoreExecution } from "./execution-recovery.ts";
import type { RunContext, RunSummary } from "./run.ts";
import {
  hasOpenBlocker,
  readChildren,
  type ReadOperation,
} from "./discovery.ts";
import {
  OperationStopped,
  OperatorCancelled,
  scopeOperator,
} from "./operations.ts";

export async function runStandalone(input: {
  number: number;
  documentation?: boolean;
  parentTicket?: number;
  loaded: LoadedProject;
  tracker: Tracker;
  context: RunContext;
  summary: RunSummary;
  read: ReadOperation;
  fetchBase: () => Promise<string>;
  codeHost: CodeHost;
  autoMerge: boolean;
  onDelivery?: (labels: string[]) => void;
  deferIntegration?: (
    pullRequest: number,
    complete: () => Promise<RunSummary>,
  ) => void;
}): Promise<RunSummary> {
  const { number, loaded, tracker, summary } = input;
  const context = {
    ...input.context,
    operator: input.documentation
      ? input.context.operator
      : scopeOperator(input.context.operator, `Issue #${number}`),
  };
  const read: ReadOperation = (operation, target, action, settings) =>
    input.read(operation, target, action, {
      operator: context.operator,
      ...settings,
    });
  const config = loaded.config;
  const purpose = input.documentation ? "documentation" : "implement";
  const repository = config.repository;
  const accept = async (progress: ImplementationProgress, text: string) => {
    const result = parseExecution(text);
    const evidence = await read(
      "inspect_implementation",
      `ticket:${number}`,
      () => context.git.inspect(progress),
    );
    verifyWorkspace(progress, evidence, result);
    if (
      input.documentation &&
      result.outcome === "no_change" &&
      evidence.changed
    )
      throw new Error("Documentation no_change requires an unchanged Worktree");
    return result;
  };
  const progressFile = path.join(
    loaded.directory,
    "recovery",
    `${context.inputHash}-${input.documentation ? "document-" : ""}${number}.json`,
  );
  // Cancellation must still retain known unsent work in the local checkpoint.
  const persist = (progress: ImplementationProgress) =>
    context.signal?.aborted
      ? saveProgress(progressFile, progress)
      : read("save_implementation_checkpoint", `ticket:${number}`, () =>
          saveProgress(progressFile, progress),
        );
  const restored = await restoreExecution({
    file: progressFile,
    loaded,
    project: summary.project,
    number,
    repository,
    targetBranch: summary.targetBranch,
    documentation: input.documentation === true,
    runId: context.runId,
  });
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
    if (input.documentation) {
      if (
        ticket.assignees?.length ||
        !ticket.labels?.includes(config.maintenanceTicket.label) ||
        ticket.labels.includes(config.tracker.reservationLabel)
      )
        return {
          ticket,
          reason:
            "Maintenance Ticket lost its standalone markers or became externally owned",
        };
    } else if (!ticket.labels?.includes("ready-for-agent"))
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
  const hasRunner =
    selected.ticket.assignees?.includes(config.tracker.runnerAccount) ?? false;
  const hasLabel =
    selected.ticket.labels?.includes(config.tracker.reservationLabel) ?? false;
  const beforeDispatch = async () => {
    selected = await inspect();
    if (
      !selected.reason &&
      !input.documentation &&
      (!selected.ticket.assignees?.includes(config.tracker.runnerAccount) ||
        !selected.ticket.labels?.includes(config.tracker.reservationLabel))
    )
      selected.reason = "Reservation changed before dispatch";
    return selected.reason === undefined;
  };
  const stageInput = (progress: ImplementationProgress): IssueStageContext => ({
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
  });
  const publish = (progress: ImplementationProgress) =>
    publishImplementation({
      ...stageInput(progress),
      context,
      codeHost: input.codeHost,
      read,
      autoMerge: input.autoMerge,
      stageInput: stageInput(progress),
    });
  const integrate = async (
    progress: ImplementationProgress,
    publicationReason?: string,
  ): Promise<RunSummary> => {
    if (
      publicationReason !== undefined &&
      (!input.autoMerge || progress.publication?.phase === "checks_failed")
    )
      return { ...summary, reasons: [publicationReason] };
    const complete = async (): Promise<RunSummary> => {
      try {
        const delivery = await integrateImplementation({
          ...stageInput(progress),
          context,
          codeHost: input.codeHost,
          tracker,
          read,
          inspectTicket: inspect,
          continuePublication: () => publish(progress),
        });
        if (delivery.outcome === "succeeded")
          input.onDelivery?.(progress.publication!.deliveryLabels!);
        return {
          ...summary,
          outcome: delivery.outcome,
          reasons: [delivery.reason],
        };
      } catch (error) {
        if (!(error instanceof OperationStopped)) throw error;
        return { ...summary, reasons: [selected.reason ?? error.message] };
      }
    };
    if (input.deferIntegration) {
      input.deferIntegration(
        progress.publication!.pullRequest!.number,
        complete,
      );
      return {
        ...summary,
        reasons: [
          `CI-ready PR ${progress.publication!.pullRequest!.url} awaits Batch integration`,
        ],
      };
    }
    return complete();
  };
  if (
    restored?.publication &&
    [
      "conflict_repair",
      "pending_merge",
      "merge_requested",
      "merged",
      "delivered",
    ].includes(restored.publication.phase)
  )
    return integrate(restored);
  if (
    selected.reason &&
    !(
      input.documentation &&
      restored?.noChangeClosure !== undefined &&
      selected.ticket.stateReason === "completed"
    )
  )
    return {
      ...summary,
      outcome: selected.ticket.state === "closed" ? "no_work" : "incomplete",
      reasons: [selected.reason],
    };
  async function run(progress: ImplementationProgress): Promise<RunSummary> {
    if (progress.result) {
      if (
        [
          "implementation_completed",
          "documentation_completed",
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
        ...stageInput(progress),
        stage: progress,
        purpose,
        task: async () =>
          `${input.documentation ? documentationInstructions : implementationInstructions}\n\n${await readFile(path.join(loaded.directory, "prompts", `${purpose}.md`), "utf8")}\n\n` +
          `Repository: ${repository}\nIssue #${number}: ${selected.ticket.title ?? ""}\n${selected.ticket.body ?? ""}\n` +
          `Worktree: ${progress.worktree}\nDelivery branch: ${progress.branch}\nBase SHA: ${progress.base}\nTarget Branch: ${progress.target_branch}`,
        accept: (text) => accept(progress, text),
      });
    }
    if (
      progress.result?.outcome === "committed" &&
      !input.documentation &&
      config.workflow.review &&
      !progress.publication
    )
      await reviewImplementation({
        ...stageInput(progress),
        git: context.git,
        read,
      });
    if (!selected.reason && progress.result?.outcome === "committed") {
      try {
        return integrate(progress, await publish(progress));
      } catch (error) {
        if (!(error instanceof OperationStopped)) throw error;
        return { ...summary, reasons: [selected.reason ?? error.message] };
      }
    }
    if (input.documentation && progress.result?.outcome === "no_change") {
      await closeDocumentationNoChange({
        ...stageInput(progress),
        tracker,
        read,
        inspectTicket: inspect,
        verify: async () => {
          await accept(progress, JSON.stringify(progress.result));
        },
      });
      return {
        ...summary,
        outcome: "succeeded",
        reasons: [`Completed Maintenance Ticket ${number} with no changes`],
      };
    }
    return {
      ...summary,
      reasons: [
        selected.reason ??
          (progress.result?.outcome === "no_change"
            ? "Implementation completed with no_change; no Issue delivery"
            : "Implementation stage completed; Issue delivery remains incomplete"),
      ],
    };
  }
  if (!input.documentation && restored && (!hasRunner || !hasLabel))
    return {
      ...summary,
      reasons: ["Recorded Reservation changed before continuation"],
    };
  if (restored && restored.phase !== "reserved") return run(restored);
  if (!input.documentation && (hasRunner || hasLabel))
    return {
      ...summary,
      reasons: [
        `existing Reservation${hasRunner !== hasLabel ? " (partial)" : ""}; no recorded ownership for this Run`,
      ],
    };
  if (!input.documentation) {
    const { runnerAccount } = config.tracker;
    // Confirm each write from current tracker state before retrying it.
    await read(
      "add_reservation_label",
      `ticket:${number}`,
      async () => {
        selected = await inspect();
        if (selected.reason) return;
        if (selected.ticket.assignees?.includes(runnerAccount)) {
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
          return selected.ticket.labels?.includes(
            config.tracker.reservationLabel,
          )
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
        if (
          !selected.ticket.labels?.includes(config.tracker.reservationLabel)
        ) {
          selected.reason = "Reservation changed before assignment";
          return;
        }
        if (!selected.ticket.assignees?.includes(runnerAccount))
          await tracker.addAssignee(repository, number, runnerAccount);
      },
      {
        reconcile: async () => {
          selected = await inspect();
          return selected.ticket.assignees?.includes(runnerAccount)
            ? { outcome: "completed", result: undefined }
            : { outcome: "pending" };
        },
      },
    );
    if (selected.reason) return { ...summary, reasons: [selected.reason] };
  }
  if (!(await beforeDispatch()))
    return {
      ...summary,
      reasons: [selected.reason ?? "Reservation changed before dispatch"],
    };
  const executionId = randomUUID();
  const progress: ImplementationProgress = restored ?? {
    ...(input.documentation ? { purpose: "documentation" } : {}),
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
  if (!restored || !existsSync(progress.worktree))
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
  return run(progress);
}
