import { randomUUID } from "node:crypto";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import type { LoadedProject } from "../config.ts";
import type { ExecutionResult, ImplementationProgress } from "../recovery.ts";
import type { Clock, OperatorIO, Ticket } from "../run/contracts.ts";
import { OperatorCancelled } from "../run/operations.ts";
import type { TerminalPlugin } from "../terminal.ts";
import { NativeConversations } from "./conversation.ts";
import { implementationInstructions } from "../prompts/implement.ts";
import { nonempty, object, readHandoff } from "./handoff.ts";

export async function implementIssue(input: {
  loaded: LoadedProject;
  ticket: Ticket;
  progress: ImplementationProgress;
  persist: () => Promise<void>;
  accept: (text: string) => Promise<ExecutionResult>;
  terminal: TerminalPlugin;
  clock: Clock;
  operator: OperatorIO;
  signal?: AbortSignal;
}): Promise<void> {
  const { loaded, progress, signal, clock, operator } = input;
  const profile = loaded.config.agents.implement;
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
      `Issue #${progress.ticket} implement sessionid=${progress.roles.implement?.sessionid ?? "pending"} handoff=${file}`,
    );
  const sleep = async (ms: number) => {
    signal?.throwIfAborted();
    await clock.sleep(ms);
    signal?.throwIfAborted();
  };
  await mkdir(path.join(loaded.directory, "handoffs"), { recursive: true });
  const gitConfig = path.join(loaded.directory, `git-config-${randomUUID()}`);
  const authorization = Buffer.from(
    `x-access-token:${loaded.codeHostToken}`,
  ).toString("base64");
  await writeFile(
    gitConfig,
    `[user]\n\tname = Issue Runner\n\temail = issue-runner@users.noreply.github.com\n[http "https://github.com/"]\n\textraHeader = Authorization: Basic ${authorization}\n`,
    { mode: 0o600 },
  );
  try {
    progress.probe ??= { probe_id: randomUUID(), path: assignment("probe") };
    if (!progress.roles.implement) progress.phase = "probing";
    await persist();
    show(progress.invocation?.path ?? progress.probe.path);
    const tab = await conversations.open(
      {
        cwd: progress.worktree,
        env: { GIT_CONFIG_GLOBAL: gitConfig },
        label: `Issue #${progress.ticket} implement`,
      },
      profile,
      progress.roles.implement?.sessionid,
    );
    if (!progress.roles.implement) {
      const probeAssignment = {
        ...progress.probe,
        run_id: progress.run_id,
        execution_id: progress.execution_id,
        project: progress.project,
        repository: progress.repository,
        ticket: progress.ticket,
        role: "implement",
      };
      const prompt =
        `Session Probe\n${JSON.stringify(probeAssignment)}\n\n` +
        `Before implementation, determine the actual native conversation sessionid from your native CLI context. Never use a generated ID, tab ID, or latest-session alias. ` +
        `Inspect the repository's AGENTS.md, contribution instructions and PR conventions. Generate complete pr_title and pr_body for ${progress.repository}#${progress.ticket}.\n` +
        `Issue: ${input.ticket.title ?? ""}\n${input.ticket.body ?? ""}\n` +
        `Write exactly the assignment fields above plus sessionid, pr_title, pr_body as JSON to ${progress.probe.path}.tmp, close it, and atomically rename it to ${progress.probe.path}. Do not implement yet.`;
      await conversations.submit(tab, prompt, profile.submitKey);
      let previous = "";
      for (;;) {
        signal?.throwIfAborted();
        const observed = await readHandoff(progress.probe.path);
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
                Object.keys(probeAssignment).length + 3 ||
              !nonempty(probe.sessionid) ||
              !nonempty(probe.pr_title) ||
              !nonempty(probe.pr_body) ||
              [
                progress.probe.probe_id,
                progress.execution_id,
                progress.run_id,
                "latest",
                "last",
              ].includes(probe.sessionid)
            )
              throw new Error(
                "Probe requires actual native identity and complete PR metadata",
              );
            progress.roles.implement = { sessionid: probe.sessionid };
            progress.pr_title = probe.pr_title;
            progress.pr_body = probe.pr_body;
            accepted = true;
          } catch (error) {
            operator.write(
              `Invalid Probe: ${error instanceof Error ? error.message : String(error)}. Correct the displayed Probe file in the native conversation.`,
            );
          }
          if (accepted) {
            await persist();
            break;
          }
        }
        await sleep(250);
      }
    }
    const resuming = progress.invocation !== undefined;
    progress.invocation ??= {
      invocation_id: randomUUID(),
      path: assignment("implement"),
    };
    progress.phase = "implementing";
    await persist();
    show(progress.invocation.path);
    if (resuming) {
      if ((await readHandoff(progress.invocation.path)) === undefined)
        await conversations.submit(tab, "continue", profile.submitKey);
    } else {
      const projectPrompt = await readFile(
        path.join(loaded.directory, "prompts", "implement.md"),
        "utf8",
      );
      await conversations.submit(
        tab,
        `Implementation assignment\n${JSON.stringify({ execution_id: progress.execution_id, ...progress.invocation })}\n\n${implementationInstructions}\n\n${projectPrompt}\n\n` +
          `Repository: ${progress.repository}\nIssue #${progress.ticket}: ${input.ticket.title ?? ""}\n${input.ticket.body ?? ""}\n` +
          `Worktree: ${progress.worktree}\nDelivery branch: ${progress.branch}\nBase SHA: ${progress.base}\nTarget Branch: ${progress.target_branch}\n` +
          `Fixed PR title: ${progress.pr_title}\nFixed PR body:\n${progress.pr_body}\n\n` +
          `Explicitly invoke the installed issue-runner-handoff skill with this sole absolute output-path argument: ${JSON.stringify(progress.invocation.path)}`,
        profile.submitKey,
      );
    }
    let previous = "";
    for (;;) {
      signal?.throwIfAborted();
      const observed = await readHandoff(progress.invocation.path);
      if (observed !== undefined && observed.revision !== previous) {
        previous = observed.revision;
        let result;
        try {
          result = await input.accept(observed.text);
          signal?.throwIfAborted();
        } catch (error) {
          signal?.throwIfAborted();
          if (error instanceof OperatorCancelled) throw error;
          const reason = error instanceof Error ? error.message : String(error);
          operator.write(`Invalid implementation handoff: ${reason}`);
          // Missing output never spends this budget or generates reminders.
          if (progress.corrections < loaded.config.agentRetry) {
            progress.superseded.push(progress.invocation.path);
            progress.corrections += 1;
            progress.invocation = {
              invocation_id: randomUUID(),
              path: assignment("implement"),
            };
            await persist();
            show(progress.invocation.path);
            await sleep(
              1000 *
                loaded.config.agentRetryDelay[
                  Math.min(
                    progress.corrections - 1,
                    loaded.config.agentRetryDelay.length - 1,
                  )
                ]!,
            );
            await conversations.submit(
              tab,
              `Correct the implementation handoff: ${reason}\nExplicitly invoke issue-runner-handoff with the sole absolute output-path argument: ${JSON.stringify(progress.invocation.path)}`,
              profile.submitKey,
            );
            previous = "";
            continue;
          }
          show(progress.invocation.path);
          await sleep(250);
          continue;
        }
        progress.result = result;
        progress.phase = "implementation_completed";
        await persist();
        signal?.throwIfAborted();
        await conversations.close(tab);
        return;
      }
      await sleep(250);
    }
  } finally {
    await rm(gitConfig, { force: true });
  }
}
