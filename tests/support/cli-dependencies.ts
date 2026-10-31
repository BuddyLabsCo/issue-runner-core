/* eslint-disable @typescript-eslint/require-await -- Scripted external contracts retain asynchronous signatures. */
import assert from "node:assert/strict";
import { LocalGitWorkspace } from "../../src/adapters/git-workspace.ts";
import type {
  CodeHost,
  PullRequestRecord,
  RequiredCheck,
  PullRequestState,
  MergeRequestResult,
} from "../../src/run/contracts.ts";

export function createCliDependencies(launchDirectory: string) {
  const git = new LocalGitWorkspace("host-secret");
  const messages: string[] = [];
  const effects: string[] = [];
  const reads: string[] = [];
  const pauses: string[] = [];
  const remoteBranches = new Map<string, string>();
  const pullRequests: PullRequestRecord[] = [];
  return {
    launchDirectory,
    env: { TRACKER_TOKEN: "tracker-secret", HOST_TOKEN: "host-secret" },
    messages,
    effects,
    reads,
    pauses,
    tracker: {
      async closeTicket() {
        assert.fail("unexpected Issue closure");
      },
      async getTicket(_repository: string, ticket: number) {
        return { number: ticket, state: "open" as const, stateReason: null };
      },
      async listBlockersPage() {
        return { blockers: [], nextPage: null };
      },
      async addAssignee() {
        effects.push("assign");
      },
      async getParent(repository: string, ticket: number) {
        reads.push(`${repository}#${ticket}`);
        return { number: ticket, state: "open" as const, stateReason: null };
      },
      async listChildrenPage(
        _repository: string,
        _ticket: number,
        page: number,
      ) {
        reads.push(`children:${page}`);
        return { children: [], nextPage: null };
      },
      async closeParent() {
        effects.push("close_parent");
      },
      async addLabel() {
        effects.push("reserve");
      },
    },
    codeHost: {
      async getPullRequest(
        _repository: string,
        number: number,
      ): Promise<PullRequestState> {
        return {
          headSha:
            pullRequests.find((pr) => pr.number === number)?.headSha ??
            "b".repeat(40),
          createdAt: "2026-10-30T00:00:00Z",
          merged: false,
          mergeRequested: false,
          mergeable: "conflicting",
          mergeFailure: null,
        };
      },
      async requestSquashMerge(): Promise<MergeRequestResult> {
        return {
          outcome: "conflict",
          error: new Error("explicit merge conflict"),
        };
      },
      async resolveTargetBranch(repository: string) {
        reads.push(`branch:${repository}`);
        return "default-branch";
      },
      async getRemoteBranchHead(
        _repository: string,
        branch: string,
      ): Promise<string | null> {
        return remoteBranches.get(branch) ?? null;
      },
      async listPullRequests(): Promise<PullRequestRecord[]> {
        return structuredClone(pullRequests);
      },
      async createPullRequest(
        input: Parameters<CodeHost["createPullRequest"]>[0],
      ) {
        const number = 81 + pullRequests.length;
        const record: PullRequestRecord = {
          number,
          url: `https://github.com/${input.repository}/pull/${number}`,
          branch: input.branch,
          targetBranch: input.targetBranch,
          headSha: (await this.getRemoteBranchHead(
            input.repository,
            input.branch,
          ))!,
          state: "open",
        };
        pullRequests.push(record);
        return { number, url: record.url };
      },
      async getRequiredChecks(): Promise<RequiredCheck[]> {
        return [];
      },
    },
    gitWorkspace: {
      async push(_worktree: string, branch: string, headSha: string) {
        remoteBranches.set(branch, headSha);
      },
      withAgentEnvironment: git.withAgentEnvironment.bind(git),
      async inspect() {
        return {
          worktree: "",
          branch: "",
          base: "",
          clean: true,
          changed: false,
          commits: [],
        };
      },
      async fetchTargetBranch() {
        effects.push("fetch");
        return "a".repeat(40);
      },
      async createWorktree() {
        effects.push("worktree");
      },
    },
    terminalPlugin: {
      async createTab() {
        effects.push("dispatch");
        return {};
      },
      async submitText() {
        effects.push("submit");
      },
      async closeTab() {
        effects.push("close_tab");
      },
    },
    clock: {
      now() {
        return new Date("2026-10-30T00:00:00.000Z");
      },
      async sleep(milliseconds: number) {
        reads.push(`sleep:${milliseconds}`);
      },
    },
    operator: {
      write(message: string) {
        messages.push(message);
      },
      async pause(message: string): Promise<string | null> {
        pauses.push(message);
        assert.fail("unexpected Operator Pause");
      },
    },
  };
}
