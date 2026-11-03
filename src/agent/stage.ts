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
import { renderPrompt } from "../prompts/load.ts";
import {
  probeInstructions,
  probeCorrectionInstructions,
  probeRecoveryInstructions,
  handoffCorrectionInstructions,
  resumeInstructions,
  recoveryInstructions,
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
    phase: "documenting",
    completed: "documentation_completed",
  },
  implement: {
    name: "implementation",
    phase: "implementing",
    completed: "implementation_completed",
  },
  review: {
    name: "Review",
    phase: "reviewing",
    completed: "review_completed",
  },
  fix_review: {
    name: "Review fix",
    phase: "fixing_review",
    completed: "fix_review_completed",
  },
  conflict_repair: {
    name: "Conflict repair",
    phase: "repairing_conflict",
    completed: "conflict_repair_completed",
  },
  ci_repair: {
    name: "CI repair",
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
    progressLabel?: string;
    task: (handoffPath: string) => string | Promise<string>;
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
  const primaryExecution =
    purpose === "implement" || purpose === "documentation";
  const { name, phase, completed } = stageDetails[purpose];
  const repairRole =
    purpose === "ci_repair"
      ? "ciRepair"
      : purpose === "conflict_repair"
        ? "conflictRepair"
        : undefined;
  const profile = loaded.config.agents[repairRole ?? role]!;
  const sessionid = () =>
    repairRole ? stage.sessionid : progress.roles[role]?.sessionid;
  const conversations = new NativeConversations(input.terminal, signal);
  const persist = input.persist;
  const assignment = (phase: string) =>
    path.join(
      loaded.directory,
      "handoffs",
      `${progress.ticket}-${phase}-${clock.now().toISOString().replace(/[:.]/gu, "")}-${randomUUID()}.json`,
    );
  const show = (file: string) =>
    operator.write(
      `Issue #${progress.ticket} ${input.progressLabel ?? purpose} sessionid=${sessionid()} handoff=${file}`,
    );
  const sleep = async (ms: number) => {
    signal?.throwIfAborted();
    await clock.sleep(ms);
    signal?.throwIfAborted();
  };
  await mkdir(path.join(loaded.directory, "handoffs"), { recursive: true });
  await input.withEnvironment(async (env) => {
    let tab: TabHandle | undefined;
    let ready = false;
    const saveIdentity = (ref: unknown, expected?: string) => {
      if (
        !nonempty(ref) ||
        [progress.execution_id, progress.run_id, "latest", "last"].includes(
          ref,
        ) ||
        (expected !== undefined && ref !== expected)
      )
        throw new Error(
          "Invalid native session identity: expected the actual native ref and exact resume identity",
        );
      if (repairRole) stage.sessionid = ref;
      else progress.roles[role] = { sessionid: ref };
    };
    const open = async () => {
      tab ??= await conversations.create({
        cwd: input.worktree ?? progress.worktree,
        env,
        label: `issue-${progress.ticket} ${(input.progressLabel ?? purpose).replace(/_/gu, " ").replace(/ round /u, " r")}`,
        agent: profile.agent,
        submitKey: profile.submitKey ?? "Enter",
        ...(signal ? { signal } : {}),
      });
      if (!ready) {
        const expected = sessionid();
        const ref = await conversations.start(tab, profile, expected);
        signal?.throwIfAborted();
        if (ref !== undefined || expected !== undefined) {
          saveIdentity(ref, expected);
          await persist();
        }
        ready = true;
      }
      return tab;
    };
    // A retained fallback Probe can establish identity before any exact resume.
    if (!sessionid() && !(stage.probe && (await readHandoff(stage.probe.path))))
      await open();
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
      await conversations.submit(
        tab,
        text,
        profile.submitKey,
        stage.invocation!.path,
        renderPrompt(recoveryInstructions, {
          name,
          path: JSON.stringify(stage.invocation!.path),
        }),
      );
      return true;
    };
    if (!sessionid()) {
      stage.probe ??= { path: assignment(`${purpose}-probe`) };
      if (primaryExecution) progress.phase = "probing";
      await persist();
      const prompt = (error?: string) =>
        renderPrompt(probeInstructions, {
          correction: error
            ? renderPrompt(probeCorrectionInstructions, { reason: error })
            : "",
          issue: String(progress.ticket),
          temporary: JSON.stringify(`${stage.probe!.path}.tmp`),
          path: JSON.stringify(stage.probe!.path),
        });
      if (
        (purpose !== "documentation" && !repairRole) ||
        !(await readHandoff(stage.probe.path))
      )
        await conversations.submit(
          await open(),
          prompt(),
          profile.submitKey,
          stage.probe.path,
          renderPrompt(probeRecoveryInstructions, {
            temporary: JSON.stringify(`${stage.probe.path}.tmp`),
            path: JSON.stringify(stage.probe.path),
          }),
        );
      for (;;) {
        signal?.throwIfAborted();
        const observed = await readHandoff(stage.probe.path);
        if (observed !== undefined) {
          try {
            const probe = object(JSON.parse(observed.text) as unknown);
            if (Object.keys(probe).join(",") !== "sessionid")
              throw new Error("Probe requires actual native identity only");
            try {
              saveIdentity(probe.sessionid);
            } catch (error) {
              throw new Error("Probe requires actual native identity", {
                cause: error,
              });
            }
          } catch (error) {
            const reason =
              error instanceof Error ? error.message : String(error);
            if (!tab)
              throw new Error(
                `unable to recover: invalid native ${name} Probe: ${reason}`,
                { cause: error },
              );
            operator.write(
              `Invalid Probe: ${reason}. Correct the Probe in the native conversation; rejected handoff=${stage.probe.path}`,
            );
            stage.superseded.push(stage.probe.path);
            stage.probe = {
              path: assignment(`${purpose}-probe`),
            };
            await persist();
            await conversations.submit(
              await open(),
              prompt(reason),
              profile.submitKey,
              stage.probe.path,
              renderPrompt(probeRecoveryInstructions, {
                temporary: JSON.stringify(`${stage.probe.path}.tmp`),
                path: JSON.stringify(stage.probe.path),
              }),
            );
            continue;
          }
          await persist();
          break;
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
      stage.pendingPrompt = await input.task(stage.invocation.path);
    }
    progress.phase = phase;
    await persist();
    show(stage.invocation.path);
    for (;;) {
      signal?.throwIfAborted();
      const observed = await readHandoff(stage.invocation.path);
      if (observed === undefined && stage.pendingPrompt !== undefined) {
        if (!(await submitWork(stage.pendingPrompt))) return;
        resumeIfMissing = false;
        continue;
      }
      if (
        resumeIfMissing &&
        observed === undefined &&
        !(await submitWork(resumeInstructions))
      )
        return;
      resumeIfMissing = false;
      if (observed !== undefined) {
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
          stage.superseded.push(stage.invocation.path);
          stage.invocation = {
            invocation_id: randomUUID(),
            path: assignment(purpose),
          };
          stage.pendingPrompt = renderPrompt(handoffCorrectionInstructions, {
            name,
            reason,
            path: JSON.stringify(stage.invocation.path),
          });
          await persist();
          show(stage.invocation.path);
          continue;
        }
        stage.result = result;
        delete stage.pendingPrompt;
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
