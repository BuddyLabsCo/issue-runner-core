/* eslint-disable @typescript-eslint/require-await -- Scripted external boundaries. */
import assert from "node:assert/strict";
import { mkdir } from "node:fs/promises";
import type { TestContext } from "node:test";
import { executeCli } from "../../src/cli.ts";
import type {
  Ticket,
  Tracker,
  WorkspaceEvidence,
} from "../../src/run/contracts.ts";
import { createProject, validConfig } from "./cli-project.ts";
import { createCliDependencies } from "./cli-dependencies.ts";
import {
  committed,
  implementationCommit,
  publish,
} from "./implementation-run.ts";

export function child(number: number, extra: Partial<Ticket> = {}): Ticket {
  return {
    number,
    repository: "owner/repo",
    state: "open",
    stateReason: null,
    labels: ["ready-for-agent"],
    assignees: [],
    ...extra,
  };
}

export async function parentRun(
  t: TestContext,
  children: Ticket[],
  config: Omit<typeof validConfig, "issueList"> & {
    issueList: number[];
  } = validConfig,
) {
  const { root, directory } = await createProject(t, config);
  const deps = createCliDependencies(root);
  const controller = new AbortController();
  const writes: string[] = [];
  const dispatched: number[] = [];
  const tabs = new Map<object, WorkspaceEvidence>();
  const worktrees = new Map<string, WorkspaceEvidence>();
  const tracker: Tracker = {
    ...deps.tracker,
    async listChildrenPage() {
      return { children: structuredClone(children), nextPage: null };
    },
    async getTicket(_repository, number) {
      return structuredClone(
        children.find((ticket) => ticket.number === number)!,
      );
    },
    async addLabel(_repository, number, label) {
      writes.push(`label:${number}`);
      children.find((ticket) => ticket.number === number)!.labels!.push(label);
    },
    async addAssignee(_repository, number, account) {
      writes.push(`assignee:${number}`);
      children
        .find((ticket) => ticket.number === number)!
        .assignees!.push(account);
    },
  };
  const dependencies = {
    ...deps,
    tracker,
    signal: controller.signal,
    gitWorkspace: {
      ...deps.gitWorkspace,
      async createWorktree(input: {
        worktree: string;
        branch: string;
        base: string;
      }) {
        await mkdir(input.worktree, { recursive: true });
        worktrees.set(input.worktree, {
          ...input,
          clean: true,
          changed: false,
          commits: [],
        });
      },
      async inspect(input: { worktree: string }) {
        return structuredClone(worktrees.get(input.worktree)!);
      },
    },
    terminalPlugin: {
      async createTab(options: { cwd: string }) {
        const tab = {};
        tabs.set(tab, worktrees.get(options.cwd)!);
        return tab;
      },
      async submitText(tab: object, text: string) {
        if (text.startsWith("Session Probe\n")) {
          const assignment = JSON.parse(text.split("\n")[1]!) as Record<
            string,
            unknown
          >;
          await publish(String(assignment.path), {
            ...assignment,
            sessionid: `native-${String(assignment.ticket)}`,
            pr_title: `feat: [issue-${String(assignment.ticket)}] implement`,
            pr_body: `Implement.\n\nCloses #${String(assignment.ticket)}`,
          });
        } else if (text.startsWith("Implementation assignment\n")) {
          const assignment = JSON.parse(text.split("\n")[1]!) as {
            path: string;
          };
          const evidence = tabs.get(tab)!;
          evidence.changed = true;
          evidence.commits = [implementationCommit];
          dispatched.push(Number(/ticket-(\d+)$/u.exec(evidence.worktree)![1]));
          await publish(assignment.path, committed());
        }
      },
      async closeTab() {
        assert.ok(tabs.size > 0);
      },
    },
  };
  return {
    directory,
    dependencies,
    controller,
    writes,
    dispatched,
    run: () =>
      executeCli(
        ["run", "--project", "demo", "--env", "fake", "--parent", "48"],
        dependencies,
      ),
  };
}
