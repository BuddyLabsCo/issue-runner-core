/* eslint-disable @typescript-eslint/require-await -- Scripted external boundaries. */
import assert from "node:assert/strict";
import { mkdir, readFile, readdir, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import type { TestContext } from "node:test";
import { executeCli } from "../../src/cli.ts";
import type { ImplementationProgress } from "../../src/recovery.ts";
import type { TerminalPlugin } from "../../src/terminal.ts";
import type { Ticket, WorkspaceEvidence } from "../../src/run/contracts.ts";
import { createProject, validConfig } from "./cli-project.ts";
import { createCliDependencies } from "./cli-dependencies.ts";

export const implementationCommand = [
  "run",
  "--project",
  "demo",
  "--env",
  "fake",
  "--issue",
  "50",
];
export const implementationCommit = {
  sha: "b".repeat(40),
  message: "feat: implement the Issue",
};

export function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}

export async function implementationProgress(
  directory: string,
  ticket: number,
): Promise<ImplementationProgress> {
  const recovery = path.join(directory, "recovery");
  const files = (await readdir(recovery)).filter((file) =>
    file.endsWith(`-${ticket}.json`),
  );
  assert.equal(files.length, 1);
  return JSON.parse(
    await readFile(path.join(recovery, files[0]!), "utf8"),
  ) as ImplementationProgress;
}

export async function implementationRun(
  t: TestContext,
  config: typeof validConfig & {
    workflow?: { review?: boolean; maxReviewRounds?: number };
  } = validConfig,
) {
  const { root, directory } = await createProject(t, {
    ...config,
    workflow: { review: false, ...config.workflow },
  });
  const deps = createCliDependencies(root);
  const controller = new AbortController();
  const state = {
    events: [] as string[],
    submissions: [] as { tab: object; text: string; chord?: string }[],
    ticket: {
      number: 50,
      state: "open",
      stateReason: null,
      title: "Implement the Issue",
      body: "Accepted scope",
      labels: ["ready-for-agent"],
      assignees: [],
    } as Ticket,
    evidence: {
      worktree: "",
      branch: "",
      base: "a".repeat(40),
      clean: true,
      changed: true,
      commits: [],
    } as WorkspaceEvidence,
    expectedPath: "",
    gitConfigs: [] as string[],
    closedTabs: [] as object[],
    sleeps: [] as number[],
    taskCount: 0,
    probeCount: 0,
    onProbe: async (assignment: Record<string, unknown>) => {
      await publish(String(assignment.path), {
        ...assignment,
        sessionid: "native/$&/$`/$'/session",
        pr_title: "feat: [issue-50] implement the Issue",
        pr_body: "Implement the Issue.\n\nCloses #50",
      });
    },
    onTask: async (file: string) => {
      state.evidence.commits = [implementationCommit];
      await publish(file, committed());
    },
    onCorrection: async (file: string) => {
      await publish(file, committed());
    },
    onSleep: async (ms: number) => {
      assert.ok(ms > 0);
    },
    onClose: async () => {
      /* Controlled by the scenario. */
    },
  };
  const snapshot = () => implementationProgress(directory, 50);
  const terminal: TerminalPlugin = {
    async createTab(options) {
      state.events.push("open");
      state.gitConfigs.push(options.env.GIT_CONFIG_GLOBAL!);
      return {};
    },
    async submitText(tab, text, chord) {
      state.submissions.push({ tab, text, ...(chord ? { chord } : {}) });
      state.events.push("submit");
      if (text.startsWith("Session Probe\n")) {
        state.probeCount += 1;
        const assignment = JSON.parse(
          text.slice(text.indexOf("\n") + 1, text.indexOf("\n\n")),
        ) as Record<string, unknown>;
        await state.onProbe(assignment);
      } else if (text.startsWith("Implementation assignment\n")) {
        state.taskCount += 1;
        state.expectedPath = (await snapshot()).invocation!.path;
        await state.onTask(state.expectedPath);
      } else if (text.startsWith("Correct the implementation handoff:")) {
        state.expectedPath = (await snapshot()).invocation!.path;
        await state.onCorrection(state.expectedPath);
      }
    },
    async closeTab(tab) {
      assert.match((await snapshot()).phase, /completed$/u);
      state.closedTabs.push(tab);
      state.events.push("close");
      await state.onClose();
    },
  };
  const dependencies = {
    ...deps,
    signal: controller.signal,
    terminalPlugin: terminal,
    tracker: {
      ...deps.tracker,
      async getTicket() {
        return structuredClone(state.ticket);
      },
      async listBlockersPage() {
        return { blockers: [] as Ticket[], nextPage: null as number | null };
      },
      async addLabel(_repo: string, _ticket: number, label: string) {
        state.events.push("reserve");
        state.ticket.labels!.push(label);
      },
      async addAssignee(_repo: string, _ticket: number, account: string) {
        state.ticket.assignees!.push(account);
      },
    },
    gitWorkspace: {
      ...deps.gitWorkspace,
      async fetchTargetBranch() {
        state.events.push("fetch");
        return "a".repeat(40);
      },
      async createWorktree(input: { worktree: string; branch: string }) {
        state.events.push("worktree");
        state.evidence.worktree = input.worktree;
        state.evidence.branch = input.branch;
        await mkdir(input.worktree, { recursive: true });
      },
      async inspect(input: { base: string } = { base: state.evidence.base }) {
        state.events.push("verify");
        const evidence = structuredClone(state.evidence);
        const baseIndex = evidence.commits.findIndex(
          (commit) => commit.sha === input.base,
        );
        if (input.base !== evidence.base && baseIndex >= 0) {
          evidence.base = input.base;
          evidence.commits = evidence.commits.slice(baseIndex + 1);
        }
        return evidence;
      },
    },
    clock: {
      ...deps.clock,
      async sleep(ms: number) {
        state.sleeps.push(ms);
        await state.onSleep(ms);
      },
    },
  };
  return {
    state,
    dependencies,
    directory,
    controller,
    snapshot,
    run: () => executeCli(implementationCommand, dependencies),
  };
}

export function committed(ticket = 50) {
  return {
    outcome: "committed",
    summary: "Implemented and verified.",
    commits: [
      {
        ...implementationCommit,
        sha:
          ticket === 50
            ? implementationCommit.sha
            : ticket.toString(16).padStart(40, "b"),
      },
    ],
    findings_file: null,
  };
}

export async function publish(file: string, value: unknown) {
  await writeFile(`${file}.tmp`, JSON.stringify(value));
  await rename(`${file}.tmp`, file);
}
