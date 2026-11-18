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

async function discoverParentFixture(
  this: import("../../src/run/contracts.ts").Tracker,
  repository: string,
  number: number,
): Promise<{
  parent: import("../../src/run/contracts.ts").Ticket;
  tickets: import("../../src/run/contracts.ts").Ticket[];
  reservationId: string;
  runnerId: string;
}> {
  const parent = await this.getParent(repository, number);
  const tickets: import("../../src/run/contracts.ts").Ticket[] = [];
  let page: number | null = 1;
  const seen = new Set<number>();
  while (page !== null) {
    if (seen.has(page) || !Number.isSafeInteger(page) || page < 1)
      throw new Error("invalid child pagination");
    seen.add(page);
    const result = await this.listChildrenPage(repository, number, page);
    tickets.push(...result.children);
    page = result.nextPage;
  }
  tickets.sort((a, b) => a.number - b.number);
  for (const ticket of tickets) {
    if (ticket.repository?.toLowerCase() !== repository.toLowerCase())
      throw new Error(
        `cross-repository child ${ticket.repository}#${ticket.number} is unsupported`,
      );
    ticket.blockers = [];
    let blockerPage: number | null = 1;
    const pages = new Set<number>();
    while (blockerPage !== null) {
      if (
        pages.has(blockerPage) ||
        !Number.isSafeInteger(blockerPage) ||
        blockerPage < 1
      )
        throw new Error("invalid blocker pagination");
      pages.add(blockerPage);
      const result = await this.listBlockersPage(
        repository,
        ticket.number,
        blockerPage,
      );
      for (const blocker of result.blockers) {
        if (blocker.state === "closed" && blocker.stateReason === null)
          throw new Error("unsupported terminal state");
        ticket.blockers.push(blocker);
      }
      blockerPage = result.nextPage;
    }
  }
  return { parent, tickets, reservationId: "label", runnerId: "runner" };
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
    env: { HOST_TOKEN: "host-secret" },
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
      async getDeliveryTicket(repository: string, ticket: number) {
        return this.getTicket(repository, ticket);
      },
      async listBlockersPage(
        _repository: string,
        _ticket: number,
        _page: number,
      ): Promise<{
        blockers: import("../../src/run/contracts.ts").Ticket[];
        nextPage: number | null;
      }> {
        void [_repository, _ticket, _page];
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
      ): Promise<import("../../src/run/contracts.ts").ChildPage> {
        reads.push(`children:${page}`);
        return { children: [], nextPage: null };
      },
      async readStart(
        this: import("../../src/run/contracts.ts").Tracker,
        repository: string,
        number: number,
        runner: string,
        reservation: string,
        parent?: number,
      ) {
        if (parent !== undefined)
          return this.discoverParent(repository, parent, runner, reservation);
        const ticket = await this.getTicket(repository, number);
        ticket.blockers = [];
        let page: number | null = 1;
        while (page !== null) {
          const result = await this.listBlockersPage(repository, number, page);
          ticket.blockers.push(...result.blockers);
          page = result.nextPage;
        }
        ticket.repository ??= repository;
        return {
          parent: ticket,
          tickets: [],
          reservationId: "label",
          runnerId: "runner",
        };
      },
      async addReservation(
        this: import("../../src/run/contracts.ts").Tracker,
        ticket: import("../../src/run/contracts.ts").Ticket,
        label: { id: string; name: string } | undefined,
        runner: { id: string; login: string } | undefined,
      ) {
        if (label)
          await this.addLabel(ticket.repository!, ticket.number, label.name);
        if (runner)
          await this.addAssignee(
            ticket.repository!,
            ticket.number,
            runner.login,
          );
      },
      discoverParent: discoverParentFixture,
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
