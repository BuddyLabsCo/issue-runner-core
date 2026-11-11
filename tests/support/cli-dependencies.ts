/* eslint-disable @typescript-eslint/require-await -- Scripted external contracts retain asynchronous signatures. */
import assert from "node:assert/strict";
import type { CreateTabOptions, TabHandle } from "../../src/terminal.ts";
import { LocalGitWorkspace } from "../../src/adapters/git-workspace.ts";
import type {
  CodeHost,
  PullRequestRecord,
  RequiredCheck,
  PullRequestState,
  MergeRequestResult,
} from "../../src/run/contracts.ts";

export function terminalModule(plugin: TestTerminal) {
  const calls: unknown[][] = [];
  return {
    contractVersion: 2 as const,
    calls,
    createTerminalPlugin(...args: [unknown]) {
      calls.push(args);
      return Promise.resolve(plugin);
    },
  };
}

export function createCliDependencies(launchDirectory: string) {
  const git = new LocalGitWorkspace("host-secret");
  const messages: string[] = [];
  const effects: string[] = [];
  const reads: string[] = [];
  const pauses: string[] = [];
  const remoteBranches = new Map<string, string>();
  const pullRequests: PullRequestRecord[] = [];
  const terminalPlugin = createTestTerminal();
  terminalPlugin.onInput = async () => {
    effects.push("submit");
  };
  const create = terminalPlugin.createTab.bind(terminalPlugin);
  terminalPlugin.createTab = async (options) => {
    effects.push("dispatch");
    return create(options);
  };
  terminalPlugin.closeTab = async () => {
    effects.push("close_tab");
  };
  return {
    launchDirectory,
    env: { TRACKER_TOKEN: "tracker-secret", HOST_TOKEN: "host-secret" },
    messages,
    effects,
    reads,
    pauses,
    tracker: {
      async createLabel() {
        assert.fail("unexpected maintenance label creation");
      },
      async listLabelsPage(): Promise<{
        labels: string[];
        nextPage: number | null;
      }> {
        return { labels: [], nextPage: null };
      },
      async createMaintenanceTicket(): Promise<
        import("../../src/run/contracts.ts").Ticket
      > {
        assert.fail("unexpected Maintenance Ticket creation");
      },
      async closeTicket(): Promise<void> {
        assert.fail("unexpected Issue closure");
      },
      async commentTicket(): Promise<void> {
        assert.fail("unexpected Issue comment");
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
          mergeable: "unknown",
          mergeFailure: null,
        };
      },
      async requestSquashMerge(): Promise<MergeRequestResult> {
        return {
          outcome: "rejected",
          error: new Error("Integration is not scripted in this fixture"),
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
        const headSha = (await this.getRemoteBranchHead(
          input.repository,
          input.branch,
        ))!;
        const number = 81 + pullRequests.length;
        const record: PullRequestRecord = {
          number,
          url: `https://github.com/${input.repository}/pull/${number}`,
          branch: input.branch,
          targetBranch: input.targetBranch,
          headSha,
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
      async cleanupWorktree() {
        assert.fail("unexpected Worktree cleanup");
      },
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
    enhancements: {} as Record<
      string,
      import("../../src/terminal.ts").EnhancementModule
    >,
    commandName: "generic-terminal",
    commandVersion: "2.3.4",
    terminalPackageRoot: launchDirectory,
    terminalCliEntry: `${launchDirectory}/cli.mjs`,
    terminal: terminalModule(terminalPlugin),
    terminalPlugin,
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
        if (message.includes("Integration is not scripted in this fixture"))
          return "s";
        pauses.push(message);
        assert.fail("unexpected Operator Pause");
      },
    },
  };
}

export function createTestTerminal() {
  return {
    onInput: async (
      _tab: TabHandle,
      _text: string,
      _chord?: string,
    ): Promise<void> => {
      void [_tab, _text, _chord];
    },
    bindTab(handle: TabHandle, options: CreateTabOptions) {
      return {
        handle,
        io: {
          read: async () => "visible screen",
          sendKeys: async (_keys: readonly string[]) => {
            void _keys;
          },
          submitText: (text: string) =>
            this.onInput(handle, text, options.submitKey),
        },
      };
    },
    async createTab(options: CreateTabOptions) {
      return this.bindTab({}, options);
    },
    async execute(handle: TabHandle, command: string) {
      await this.onInput(handle, command, "Enter");
    },
    async closeTab(_handle: TabHandle) {
      void _handle;
    },
  };
}
export type TestTerminal = ReturnType<typeof createTestTerminal>;
