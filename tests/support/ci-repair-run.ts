/* eslint-disable @typescript-eslint/require-await -- Scripted external boundaries. */
import { promptAssignment } from "./prompt-assignment.ts";
import assert from "node:assert/strict";
import { mkdir } from "node:fs/promises";
import path from "node:path";
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
    tabs.set(tab.handle, options.cwd);
    return tab;
  };
  const submit = terminal.onInput.bind(terminal);
  terminal.onInput = async (tab, text, chord) => {
    const evidence = workspaces.get(tabs.get(tab)!);
    if (!evidence) return submit(tab, text, chord);
    const kind = evidence.branch.includes("conflict-repair")
      ? "conflict"
      : "ci";
    const repairs = scripts[kind];
    fixture.state.submissions.push({
      tab,
      text,
      ...(chord ? { chord } : {}),
    });
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

export async function exhaustedLegacyCiRepair(t: TestContext) {
  const fixture = await ciRepairRun(t);
  const result = {
    outcome: "no_change",
    summary: "The dependency resolves locally",
    commits: [],
    findings_file: null,
  };
  fixture.repairs.onTask = (file) => publish(file, result);
  fixture.state.onClose = async () => {
    if (fixture.state.closedTabs.length === 2) fixture.controller.abort();
  };
  assert.equal((await fixture.run()).summary.outcome, "cancelled");
  const saved = await fixture.snapshot();
  const publication = saved.publication!;
  assert.equal(publication.phase, "checks_failed");
  const budget = publication.ciRepair!;
  const secondId = "5eda78f1-bbb7-4c98-b15d-8707979b401e";
  const suffix = `ticket-50-ci-repair-${secondId}`;
  const handoffs = path.join(fixture.directory, "handoffs");
  const second = {
    ...budget.attempts[0]!,
    attempt_id: secondId,
    worktree: path.join(fixture.directory, "worktrees", saved.run_id, suffix),
    branch: `sandcastle/run-${saved.run_id}/${suffix}`,
    sessionid: "ci-session-2",
    agent: validConfig.agents.ciRepair.agent,
    resume: validConfig.agents.ciRepair.resume.replaceAll(
      "{sessionref}",
      () => "ci-session-2",
    ),
    probe: { path: path.join(handoffs, "second-probe.json") },
    invocation: {
      invocation_id: secondId,
      path: path.join(handoffs, "second-repair.json"),
    },
  };
  await fixture.dependencies.gitWorkspace.createWorktree(second);
  await publish(second.probe.path, { sessionid: second.sessionid });
  await publish(second.invocation.path, result);
  budget.attempts.push(second);
  budget.consumed = 2;
  assert.ok(
    budget.attempts.every((attempt) => attempt.actionsRerun === undefined),
  );
  await publish(
    path.join(fixture.directory, "recovery", `${saved.input_hash}-50.json`),
    saved,
  );
  return { ...fixture, publication, secondId };
}
