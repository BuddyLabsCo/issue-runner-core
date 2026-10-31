/* eslint-disable @typescript-eslint/require-await -- Scripted external boundaries. */
import { promptAssignment } from "./prompt-assignment.ts";
import assert from "node:assert/strict";
import { mkdir } from "node:fs/promises";
import type { TestContext } from "node:test";
import { executeCli } from "../../src/cli.ts";
import type { CreateTabOptions } from "../../src/terminal.ts";
import type {
  CodeHost,
  GitWorkspace,
  Ticket,
  Tracker,
  WorkspaceEvidence,
} from "../../src/run/contracts.ts";
import { createProject, validConfig } from "./cli-project.ts";
import { createCliDependencies } from "./cli-dependencies.ts";
import { committed, publish } from "./implementation-run.ts";

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
    workflow?: { review?: boolean; maxReviewRounds?: number };
  } = validConfig,
) {
  const { root, directory } = await createProject(t, {
    ...config,
    workflow: { review: false, ...config.workflow },
  });
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
      async cleanupWorktree(
        input: Parameters<GitWorkspace["cleanupWorktree"]>[0],
      ) {
        assert.ok(worktrees.has(input.worktree));
      },
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
      async createTab(options: CreateTabOptions) {
        const tab = {};
        tabs.set(tab, worktrees.get(options.cwd)!);
        return tab;
      },
      async submitText(tab: object, text: string) {
        if (text.startsWith("Session Probe\n")) {
          const assignment = promptAssignment(text) as Record<string, unknown>;
          await publish(String(assignment.path), {
            sessionid: `native-${String(assignment.ticket)}`,
            pr_title: `feat: [issue-${String(assignment.ticket)}] implement`,
            pr_body: `Implement.\n\nCloses #${String(assignment.ticket)}`,
          });
        } else if (text.startsWith("Implementation assignment\n")) {
          const assignment = promptAssignment(text) as {
            path: string;
          };
          const evidence = tabs.get(tab)!;
          evidence.changed = true;
          const number = Number(/ticket-(\d+)$/u.exec(evidence.worktree)![1]);
          const result = committed(number);
          evidence.commits = result.commits;
          dispatched.push(number);
          await publish(assignment.path, result);
        }
      },
      async closeTab(tab: object) {
        assert.ok(tabs.has(tab));
      },
    },
  };
  return {
    directory,
    dependencies,
    controller,
    writes,
    dispatched,
    run: (scope = ["--parent", "48"]) =>
      executeCli(
        ["run", "--project", "demo", "--env", "fake", ...scope],
        dependencies,
      ),
  };
}

export async function parentDeliveryRun(
  t: TestContext,
  children: Ticket[],
  config: NonNullable<Parameters<typeof parentRun>[2]> = validConfig,
) {
  const fixture = await parentRun(t, children, config);
  const parent = child(48);
  const closures: number[] = [];
  const merged = new Set<number>();
  fixture.dependencies.tracker.getParent = async () => structuredClone(parent);
  fixture.dependencies.tracker.closeTicket = async (_repository, number) => {
    closures.push(number);
    const ticket =
      number === 48
        ? parent
        : children.find((child) => child.number === number)!;
    ticket.state = "closed";
    ticket.stateReason = "completed";
  };
  fixture.dependencies.codeHost.getPullRequest = async (
    _repository,
    number,
  ) => ({
    headSha: (await fixture.dependencies.codeHost.listPullRequests()).find(
      (pr) => pr.number === number,
    )!.headSha,
    createdAt: "2026-10-30T00:00:00Z",
    merged: merged.has(number),
    mergeRequested: false,
    mergeable: "mergeable",
    mergeFailure: null,
  });
  Object.assign(fixture.dependencies.codeHost, {
    async requestSquashMerge(
      input: Parameters<CodeHost["requestSquashMerge"]>[0],
    ) {
      merged.add(input.pullRequest);
      return { outcome: "accepted" };
    },
  });
  return { ...fixture, parent, children, closures, merged };
}
