/* eslint-disable @typescript-eslint/require-await -- Scripted external boundaries. */
import { promptAssignment } from "./prompt-assignment.ts";
import assert from "node:assert/strict";
import { mkdir } from "node:fs/promises";
import type { TestContext } from "node:test";
import type { WorkspaceEvidence } from "../../src/run/contracts.ts";
import { publicationRun } from "./publication-run.ts";
import { publish } from "./implementation-run.ts";
import { validConfig } from "./cli-project.ts";

export const repairCommit = {
  sha: "c".repeat(40),
  message: "fix: required checks",
};
export const failedCheck = {
  name: "build",
  state: "FAILURE",
  link: "https://checks/build/1",
  bucket: "fail" as const,
};

export async function ciRepairRun(
  t: TestContext,
  config: Parameters<typeof publicationRun>[1] = validConfig,
  kind: "ci" | "conflict" = "ci",
) {
  const fixture = await publicationRun(t, config);
  const workspaces = new Map<string, WorkspaceEvidence>();
  const repairs = {
    tasks: [] as string[],
    probes: [] as string[],
    continuations: [] as string[],
    onTask: async (file: string, evidence: WorkspaceEvidence) => {
      evidence.commits = [repairCommit];
      evidence.changed = true;
      await publish(file, {
        outcome: "committed",
        summary: "Repaired build",
        commits: [repairCommit],
        findings_file: null,
      });
    },
  };
  const other = {
    ...repairs,
    tasks: [] as string[],
    probes: [] as string[],
    continuations: [] as string[],
  };
  const scripts = {
    ci: kind === "ci" ? repairs : other,
    conflict: kind === "conflict" ? repairs : other,
  };
  const git = fixture.dependencies.gitWorkspace;
  const create = git.createWorktree.bind(git);
  git.createWorktree = async (input) => {
    if (!/-(ci|conflict)-repair-/u.test(input.branch)) return create(input);
    await mkdir(input.worktree, { recursive: true });
    workspaces.set(input.worktree, {
      ...input,
      clean: true,
      changed: false,
      commits: [],
    });
  };
  const inspect = git.inspect.bind(git);
  git.inspect = async (input) => {
    const evidence = workspaces.get(
      (input as { worktree?: string }).worktree ?? "",
    );
    return evidence ? structuredClone(evidence) : inspect(input);
  };
  const terminal = fixture.dependencies.terminalPlugin;
  const tabs = new Map<object, string>();
  const open = terminal.createTab.bind(terminal);
  terminal.createTab = async (options) => {
    const tab = await open(options);
    tabs.set(tab, options.cwd);
    return tab;
  };
  const submit = terminal.submitText.bind(terminal);
  terminal.submitText = async (tab, text, chord) => {
    const evidence = workspaces.get(tabs.get(tab)!);
    if (!evidence) return submit(tab, text, chord);
    const kind = evidence.branch.includes("conflict-repair")
      ? "conflict"
      : "ci";
    const repairs = scripts[kind];
    fixture.state.submissions.push({ tab, text, ...(chord ? { chord } : {}) });
    if (text.startsWith("Session Probe\n")) {
      repairs.probes.push(text);
      const assignment = promptAssignment(text) as { path: string };
      await publish(assignment.path, {
        sessionid: `${kind}-session-${repairs.probes.length}`,
      });
    } else if (
      text.startsWith(
        `${kind === "ci" ? "CI" : "Conflict"} repair assignment\n`,
      )
    ) {
      repairs.tasks.push(text);
      const assignment = promptAssignment(text) as { path: string };
      await repairs.onTask(assignment.path, evidence);
    } else if (
      text === "continue" ||
      text.startsWith(
        `Correct the ${kind === "ci" ? "CI" : "Conflict"} repair handoff:`,
      )
    ) {
      const attempt = (await fixture.snapshot()).publication![
        kind === "ci" ? "ciRepair" : "conflictRepair"
      ]!.attempts.at(-1)!;
      repairs.continuations.push(text);
      await repairs.onTask(attempt.invocation!.path, evidence);
    }
  };
  fixture.publicationState.onPush = async (branch, head) => {
    fixture.publicationState.branches.set(branch, head);
    for (const pr of fixture.publicationState.pullRequests) {
      assert.equal(pr.branch, branch);
      pr.headSha = head;
    }
  };
  fixture.publicationState.onChecks = async () =>
    fixture.publicationState.pushes === 1 ? [failedCheck] : [];
  return { ...fixture, repairs, scripts, workspaces };
}
