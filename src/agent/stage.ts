import { randomUUID } from "node:crypto";
import { mkdir } from "node:fs/promises";
import path from "node:path";
import type { LoadedProject } from "../config.ts";
import type {
  ExecutionResult,
  ImplementationProgress,
  ReviewResult,
  StageProgress,
} from "../recovery.ts";
import type { Clock, OperatorIO, Ticket } from "../run/contracts.ts";
import { OperatorCancelled, TicketSkipped } from "../run/operations.ts";
import type { TabHandle, TerminalPlugin } from "../terminal.ts";
import { NativeConversations } from "./conversation.ts";
import { nonempty, object, readHandoff } from "./handoff.ts";
import {
  probeInstructions,
  probeMetadataInstructions,
  probeReviewInstructions,
  probeRepairInstructions,
  probeCorrectionInstructions,
  handoffInvocationInstructions,
  handoffCorrectionInstructions,
} from "../prompts/session.ts";

export interface IssueStageContext {
  loaded: LoadedProject;
  progress: ImplementationProgress;
  ticket: Ticket;
  persist: () => Promise<void>;
  beforeDispatch: () => Promise<boolean>;
  closeTab: (close: () => Promise<void>) => Promise<void>;
  withEnvironment: <T>(
    action: (env: Readonly<Record<string, string>>) => Promise<T>,
  ) => Promise<T>;
  terminal: TerminalPlugin;
  clock: Clock;
  operator: OperatorIO;
  signal?: AbortSignal;
}

const stageDetails = {
  documentation: {
    name: "documentation",
    heading: "Documentation",
    phase: "documenting",
    completed: "documentation_completed",
  },
  implement: {
    name: "implementation",
    heading: "Implementation",
    phase: "implementing",
    completed: "implementation_completed",
  },
  review: {
    name: "Review",
    heading: "Review",
    phase: "reviewing",
    completed: "review_completed",
  },
  fix_review: {
    name: "Review fix",
    heading: "Fix",
    phase: "fixing_review",
    completed: "fix_review_completed",
  },
  conflict_repair: {
    name: "Conflict repair",
    heading: "Conflict repair",
    phase: "repairing_conflict",
    completed: "conflict_repair_completed",
  },
  ci_repair: {
    name: "CI repair",
    heading: "CI repair",
    phase: "repairing_ci",
    completed: "ci_repair_completed",
  },
} as const;

export async function runIssueStage<R extends ExecutionResult | ReviewResult>(
  input: IssueStageContext & {
    stage: StageProgress<R>;
    purpose:
      | "implement"
      | "documentation"
      | "review"
      | "fix_review"
      | "ci_repair"
      | "conflict_repair";
    worktree?: string;
    task: () => string | Promise<string>;
    accept: (text: string) => Promise<R>;
  },
): Promise<void> {
  const { loaded, progress, stage, purpose, signal, clock, operator } = input;
  const role =
    purpose === "review"
      ? "review"
      : purpose === "documentation"
        ? "documentation"
        : "implement";
  const generatesMetadata =
    purpose === "implement" || purpose === "documentation";
  const { name, heading, phase, completed } = stageDetails[purpose];
  const repairRole =
    purpose === "ci_repair"
      ? "ciRepair"
      : purpose === "conflict_repair"
        ? "conflictRepair"
        : undefined;
  const profile = loaded.config.agents[repairRole ?? role]!;
  const sessionid = () =>
    repairRole ? stage.sessionid : progress.roles[role]?.sessionid;
  const conversations = new NativeConversations(input.terminal, clock, signal);
  const persist = input.persist;
  const assignment = (phase: string) =>
    path.join(
      loaded.directory,
      "handoffs",
      `${progress.ticket}-${phase}-${clock.now().toISOString().replace(/[:.]/gu, "")}-${randomUUID()}.json`,
    );
  const show = (file: string) =>
    operator.write(
      `Issue #${progress.ticket} ${purpose} sessionid=${sessionid() ?? "pending"} handoff=${file}`,
    );
  const sleep = async (ms: number) => {
    signal?.throwIfAborted();
    await clock.sleep(ms);
    signal?.throwIfAborted();
  };
  await mkdir(path.join(loaded.directory, "handoffs"), { recursive: true });
  await input.withEnvironment(async (env) => {
    if (!sessionid()) {
      stage.probe ??= {
        probe_id: randomUUID(),
        path: assignment(`${purpose}-probe`),
      };
      const probeIds = (stage.probeIds ??= []);
      if (!probeIds.includes(stage.probe.probe_id))
        probeIds.push(stage.probe.probe_id);
      stage.probeRetries ??= 0;
      if (generatesMetadata) progress.phase = "probing";
    }
    await persist();
    if (stage.invocation || stage.probe)
      show(stage.invocation?.path ?? stage.probe!.path);
    let tab: TabHandle | undefined;
    const open = async () =>
      (tab ??= await conversations.open(
        {
          cwd: input.worktree ?? progress.worktree,
          env,
          label: `Issue #${progress.ticket} ${purpose}`,
        },
        profile,
        sessionid(),
      ));
    const submitWork = async (text: string) => {
      const tab = await open();
      const pending = stage.pendingPrompt;
      let allowed = false;
      try {
        if (pending !== undefined) {
          // An interrupted transport attempt must not blindly replay the prompt.
          delete stage.pendingPrompt;
          await persist();
        }
        allowed = await input.beforeDispatch();
      } finally {
        if (!allowed && pending !== undefined) {
          stage.pendingPrompt = pending;
          await persist();
        }
      }
      if (!allowed) return false;
      await conversations.submit(tab, text, profile.submitKey);
      return true;
    };
    if (!sessionid()) {
      let probeAssignment = {
        ...stage.probe!,
        run_id: progress.run_id,
        execution_id: progress.execution_id,
        project: progress.project,
        repository: progress.repository,
        ticket: progress.ticket,
        role: repairRole ?? role,
      };
      const prompt = (error?: string) => {
        const values = {
          identity: generatesMetadata
            ? probeMetadataInstructions.replace(
                "{{issue}}",
                () => `${progress.repository}#${progress.ticket}`,
              ) +
              `\nIssue: ${input.ticket.title ?? ""}\n${input.ticket.body ?? ""}`
            : purpose === "review"
              ? probeReviewInstructions
              : probeRepairInstructions,
          fields: generatesMetadata
            ? "sessionid, pr_title, pr_body"
            : "sessionid",
          path: probeAssignment.path,
        };
        return (
          `Session Probe\n${JSON.stringify(probeAssignment)}\n\n` +
          (error
            ? probeCorrectionInstructions.replace("{{reason}}", () => error) +
              "\n"
            : "") +
          probeInstructions.replace(
            /\{\{(identity|fields|path)\}\}/gu,
            (_, key: keyof typeof values) => values[key],
          )
        );
      };
      if (
        (purpose !== "documentation" && !repairRole) ||
        !(await readHandoff(stage.probe!.path))
      )
        await conversations.submit(await open(), prompt(), profile.submitKey);
      let previous = "";
      for (;;) {
        signal?.throwIfAborted();
        const observed = await readHandoff(stage.probe!.path);
        if (observed !== undefined && observed.revision !== previous) {
          previous = observed.revision;
          let accepted = false;
          try {
            const probe = object(JSON.parse(observed.text) as unknown);
            for (const [key, value] of Object.entries(probeAssignment))
              if (probe[key] !== value)
                throw new Error(`Probe ${key} ownership/correlation mismatch`);
            if (
              Object.keys(probe).length !==
                Object.keys(probeAssignment).length +
                  (generatesMetadata ? 3 : 1) ||
              !nonempty(probe.sessionid) ||
              (generatesMetadata &&
                (!nonempty(probe.pr_title) || !nonempty(probe.pr_body))) ||
              [
                ...(progress.probeIds ?? []),
                ...(stage.probeIds ?? []),
                progress.execution_id,
                progress.run_id,
                "latest",
                "last",
              ].includes(probe.sessionid)
            )
              throw new Error(
                generatesMetadata
                  ? "Probe requires actual native identity and complete PR metadata"
                  : "Probe requires actual native session identity",
              );
            if (repairRole) stage.sessionid = probe.sessionid;
            else progress.roles[role] = { sessionid: probe.sessionid };
            if (generatesMetadata) {
              progress.pr_title = probe.pr_title as string;
              progress.pr_body = probe.pr_body as string;
            }
            accepted = true;
          } catch (error) {
            const reason =
              error instanceof Error ? error.message : String(error);
            if (!tab)
              throw new Error(
                `unable to recover: invalid native ${name} Probe: ${reason}`,
                { cause: error },
              );
            operator.write(
              `Invalid Probe: ${reason}. Correct the displayed Probe file in the native conversation.`,
            );
            const retries: number = stage.probeRetries ?? 0;
            if (retries < loaded.config.operationRetry) {
              stage.superseded.push(stage.probe!.path);
              stage.probeRetries = retries + 1;
              stage.probe = {
                probe_id: randomUUID(),
                path: assignment(`${purpose}-probe`),
              };
              stage.probeIds!.push(stage.probe.probe_id);
              probeAssignment = { ...probeAssignment, ...stage.probe };
              await persist();
              show(stage.probe.path);
              await sleep(
                1000 *
                  loaded.config.operationRetryDelay[
                    Math.min(
                      retries,
                      loaded.config.operationRetryDelay.length - 1,
                    )
                  ]!,
              );
              await conversations.submit(
                await open(),
                prompt(reason),
                profile.submitKey,
              );
              previous = "";
              continue;
            }
          }
          if (accepted) {
            await persist();
            break;
          }
        }
        await sleep(250);
      }
    }
    let resumeIfMissing = stage.invocation !== undefined;
    if (!stage.invocation) {
      stage.invocation = {
        invocation_id: randomUUID(),
        path: assignment(purpose),
      };
      stage.pendingPrompt =
        `${heading} assignment\n${JSON.stringify({ execution_id: progress.execution_id, ...stage.invocation })}\n\n${await input.task()}\n\n` +
        `Fixed PR title: ${progress.pr_title}\nFixed PR body:\n${progress.pr_body}\n\n` +
        handoffInvocationInstructions.replace("{{path}}", () =>
          JSON.stringify(stage.invocation!.path),
        );
    }
    progress.phase = phase;
    await persist();
    show(stage.invocation.path);
    const manualCorrection = () => {
      operator.write(
        "Automatic correction budget exhausted. Correct the work and manually invoke issue-runner-handoff at the current handoff path; Runner will keep watching it.",
      );
      show(stage.invocation!.path);
    };
    if (stage.correctionExhausted) manualCorrection();
    let previous = "";
    for (;;) {
      signal?.throwIfAborted();
      const observed = await readHandoff(stage.invocation.path);
      if (observed === undefined && stage.pendingPrompt !== undefined) {
        if (stage.correctionNotBefore !== undefined) {
          const remaining = stage.correctionNotBefore - clock.now().getTime();
          if (remaining > 0) await sleep(remaining);
          delete stage.correctionNotBefore;
          await persist();
          continue;
        }
        if (!(await submitWork(stage.pendingPrompt))) return;
        resumeIfMissing = false;
        continue;
      }
      if (
        resumeIfMissing &&
        observed === undefined &&
        !(await submitWork("continue"))
      )
        return;
      resumeIfMissing = false;
      if (observed !== undefined && observed.revision !== previous) {
        previous = observed.revision;
        let result;
        try {
          result = await input.accept(observed.text);
          signal?.throwIfAborted();
        } catch (error) {
          signal?.throwIfAborted();
          if (
            error instanceof OperatorCancelled ||
            error instanceof TicketSkipped
          )
            throw error;
          const reason = error instanceof Error ? error.message : String(error);
          operator.write(`Invalid ${name} handoff: ${reason}`);
          // Missing output never spends this budget or generates reminders.
          if (
            !stage.correctionExhausted &&
            stage.corrections < loaded.config.agentRetry
          ) {
            stage.superseded.push(stage.invocation.path);
            stage.corrections += 1;
            stage.invocation = {
              invocation_id: randomUUID(),
              path: assignment(purpose),
            };
            const values = {
              name,
              reason,
              path: JSON.stringify(stage.invocation.path),
            };
            stage.pendingPrompt = handoffCorrectionInstructions.replace(
              /\{\{(name|reason|path)\}\}/gu,
              (_, key: keyof typeof values) => values[key],
            );
            stage.correctionNotBefore =
              clock.now().getTime() +
              1000 *
                loaded.config.agentRetryDelay[
                  Math.min(
                    stage.corrections - 1,
                    loaded.config.agentRetryDelay.length - 1,
                  )
                ]!;
            await persist();
            show(stage.invocation.path);
            previous = "";
            continue;
          }
          stage.correctionExhausted = true;
          delete stage.pendingPrompt;
          delete stage.correctionNotBefore;
          await persist();
          manualCorrection();
          await sleep(250);
          continue;
        }
        stage.result = result;
        delete stage.pendingPrompt;
        delete stage.correctionNotBefore;
        progress.phase = completed;
        await persist();
        signal?.throwIfAborted();
        if (tab) {
          const owned = tab;
          await input.closeTab(() => conversations.close(owned));
        }
        return;
      }
      await sleep(250);
    }
  });
}
