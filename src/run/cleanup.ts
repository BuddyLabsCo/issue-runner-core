import { rm } from "node:fs/promises";
import path from "node:path";
import type { LoadedProject } from "../config.ts";
import type { ImplementationProgress } from "../recovery.ts";
import type { TabHandle, TerminalPlugin } from "../terminal.ts";
import type { GitWorkspace } from "./contracts.ts";
import type { ReadOperation } from "./discovery.ts";
import { publishedHead, verifiedPublication } from "./publication.ts";
import { verifiedImplementation } from "./review.ts";

export function executionTerminal(input: {
  terminal: TerminalPlugin;
  progress: ImplementationProgress;
  read: ReadOperation;
}) {
  const { terminal: plugin, progress, read } = input;
  const ownedTabs = new Set<TabHandle>();
  const terminal: TerminalPlugin = {
    createTab: (options) =>
      read(
        "create_tab",
        options.label,
        async () => {
          const tab = await plugin.createTab(options);
          ownedTabs.add(tab);
          return tab;
        },
        { retry: "manual" },
      ),
    submitText: (tab, text, chord) =>
      read(
        "submit_text",
        `ticket:${progress.ticket}:${progress.phase}`,
        () => plugin.submitText(tab, text, chord),
        { retry: "never" },
      ),
    async closeTab(tab) {
      if (!ownedTabs.has(tab)) throw new Error("Unknown Issue Runner Tab");
      await plugin.closeTab(tab);
      ownedTabs.delete(tab);
    },
  };
  return {
    terminal,
    async closeResidual() {
      for (const tab of ownedTabs)
        await read("cleanup_tab", `ticket:${progress.ticket}`, () =>
          terminal.closeTab(tab),
        );
    },
  };
}

export async function cleanupExecution(input: {
  progress: ImplementationProgress;
  loaded: LoadedProject;
  git: GitWorkspace;
  read: ReadOperation;
  persist: () => Promise<void>;
}): Promise<void> {
  const { progress, loaded, git, read, persist } = input;
  if (
    !(
      progress.purpose === "documentation" &&
      progress.noChangeClosure === "completed"
    ) &&
    (!progress.publication ||
      verifiedPublication(progress).phase !== "delivered" ||
      !progress.publication.merge?.merged ||
      progress.publication.merge.headSha !==
        publishedHead(progress.publication) ||
      progress.publication.closure?.stateReason !== "completed")
  )
    throw new Error("Cleanup requires recorded completion evidence");
  const repairs = [
    ...(progress.publication?.ciRepair?.attempts ?? []),
    ...(progress.publication?.conflictRepair?.attempts ?? []),
  ];
  const resources = [
    {
      ...progress,
      headSha:
        verifiedImplementation(progress).commits.at(-1)?.sha ?? progress.base,
    },
    ...repairs.map((repair) => ({
      ...repair,
      headSha: repair.result?.commits.at(-1)?.sha ?? repair.base,
    })),
  ];
  if (
    progress.worktree !==
      path.join(
        loaded.directory,
        "worktrees",
        progress.execution_id,
        `ticket-${progress.ticket}`,
      ) ||
    progress.branch !==
      `issue-runner/${progress.run_id}/ticket-${progress.ticket}` ||
    resources.some(
      (resource) =>
        !path.isAbsolute(resource.worktree) ||
        !resource.worktree.startsWith(
          `${path.join(loaded.directory, "worktrees")}${path.sep}`,
        ),
    )
  )
    throw new Error("Cleanup Worktree ownership mismatch");
  const stages = [
    progress,
    ...(progress.reviews ?? []).flatMap((round) => [
      round,
      ...(round.fix ? [round.fix] : []),
    ]),
    ...repairs,
  ];
  const assigned = stages
    .flatMap((stage) => [
      stage.probe?.path,
      stage.invocation?.path,
      ...stage.superseded,
    ])
    .filter((file) => file !== undefined);
  if (
    assigned.some(
      (file) =>
        path.dirname(file) !== path.join(loaded.directory, "handoffs") ||
        !path.basename(file).startsWith(`${progress.ticket}-`) ||
        !file.endsWith(".json"),
    )
  )
    throw new Error("Cleanup handoff ownership mismatch");
  const files = [...new Set(assigned.flatMap((file) => [file, `${file}.tmp`]))];
  const cleanup = (progress.cleanup ??= { worktrees: [], files: [] });
  if (
    !Array.isArray(cleanup.worktrees) ||
    !Array.isArray(cleanup.files) ||
    !cleanup.worktrees.every((file) =>
      resources.some((resource) => resource.worktree === file),
    ) ||
    !cleanup.files.every((file) => files.includes(file))
  )
    throw new Error("Invalid cleanup checkpoint");
  await persist();
  for (const resource of resources) {
    if (cleanup.worktrees.includes(resource.worktree)) continue;
    await read("cleanup_worktree", resource.worktree, async () => {
      await git.cleanupWorktree({
        checkout: loaded.config.checkout,
        worktree: resource.worktree,
        branch: resource.branch,
        headSha: resource.headSha,
      });
      cleanup.worktrees.push(resource.worktree);
      await persist();
    });
  }
  for (const file of files) {
    if (cleanup.files.includes(file)) continue;
    await read("cleanup_handoff", file, async () => {
      await rm(file, { force: true });
      cleanup.files.push(file);
      await persist();
    });
  }
}
