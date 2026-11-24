/* eslint-disable @typescript-eslint/require-await -- Scripted external contracts retain asynchronous signatures. */
import assert from "node:assert/strict";
import type { CreateTabOptions, TabHandle } from "../../src/terminal.ts";
import { LocalGitWorkspace } from "../../src/adapters/git-workspace.ts";
import { OperationStopped } from "../../src/run/operations.ts";
import { issueIdentity, observeDelivery } from "./delivery-observation.ts";
import type {
  CodeHost,
  PullRequestMergeFacts,
  ParentDiscovery,
  ParentObservation,
  IssueStartFacts,
  ReservationAdditions,
  Ticket,
  Tracker,
  PullRequestRecord,
  PublicationQuery,
  PullRequestQuery,
  PullRequestObservation,
  RequiredCheck,
  PullRequestState,
  MergeRequestResult,
  ViewerIdentity,
} from "../../src/run/contracts.ts";

export const testViewer: ViewerIdentity = {
  id: "runner",
  login: "runner",
};

async function scriptedPages(
  read: (
    page: number,
  ) => Promise<{ tickets: Ticket[]; nextPage: number | null }>,
) {
  const tickets: Ticket[] = [];
  const seen = new Set<number>();
  let page: number | null = 1;
  while (page !== null) {
    if (seen.has(page))
      throw new OperationStopped("invalid scripted pagination");
    seen.add(page);
    const result = await read(page);
    tickets.push(...result.tickets);
    page = result.nextPage;
  }
  return tickets;
}

function issueMarkers(ticket: Ticket) {
  return {
    labels: (ticket.labels ?? []).map((name) => ({ id: name, name })),
    assignees: (ticket.assignees ?? []).map((login) => ({
      id: login.toLowerCase(),
      login,
    })),
  };
}

async function readParentCompletion(
  this: Pick<Tracker, "getParent" | "listChildrenPage">,
  repository: string,
  number: number,
): Promise<ParentObservation> {
  const parent = issueIdentity(
    repository,
    await this.getParent(repository, number),
  );
  const tickets = await scriptedPages(async (page) => {
    const result = await this.listChildrenPage(repository, number, page);
    return { tickets: result.children, nextPage: result.nextPage };
  });
  return {
    parent,
    children: tickets.map((ticket) => issueIdentity(repository, ticket)),
  };
}

async function readIssueStart(
  this: Pick<
    Tracker,
    "getParent" | "listChildrenPage" | "getTicket" | "listBlockersPage"
  >,
  repository: string,
  number: number,
  { reservationLabel }: Parameters<Tracker["readIssueStart"]>[2],
  parentTicket?: number,
): Promise<IssueStartFacts> {
  const scope =
    parentTicket === undefined
      ? undefined
      : await readParentCompletion.call(this, repository, parentTicket);
  const ticket = await this.getTicket(repository, number);
  const blockers = await scriptedPages(async (page) => {
    const result = await this.listBlockersPage(repository, number, page);
    return { tickets: result.blockers, nextPage: result.nextPage };
  });
  if (
    [ticket, ...blockers].some(
      ({ state, stateReason }) => state === "closed" && stateReason === null,
    )
  )
    throw new OperationStopped(
      "Issue or blocker has an unsupported terminal state",
    );
  return {
    issue: {
      ...ticket,
      ...issueIdentity(repository, ticket),
      ...issueMarkers(ticket),
      blockers: blockers.map((blocker) => issueIdentity(repository, blocker)),
    },
    reservation: { id: reservationLabel, name: reservationLabel },
    viewer: testViewer,
    ...(scope ? { scope } : {}),
  };
}

async function reserveIssue(
  this: {
    getTicket: Tracker["getTicket"];
    addLabel(repository: string, number: number, label: string): Promise<void>;
    addAssignee(
      repository: string,
      number: number,
      account: string,
    ): Promise<void>;
  },
  { issue, reservation, viewer, addLabel, addRunner }: ReservationAdditions,
) {
  if (addLabel)
    await this.addLabel(issue.repository, issue.number, reservation.name);
  if (addRunner)
    await this.addAssignee(issue.repository, issue.number, viewer.login);
  const ticket = await this.getTicket(issue.repository, issue.number);
  if (ticket.state !== issue.state || ticket.stateReason !== issue.stateReason)
    throw new Error("Unexpected Issue state in Reservation response");
  return issueMarkers(ticket);
}

async function discoverParent(
  this: Pick<Tracker, "getParent" | "listChildrenPage" | "listBlockersPage">,
  repository: string,
  parentTicket: number,
  { reservationLabel }: Parameters<Tracker["discoverParent"]>[2],
): Promise<ParentDiscovery> {
  const parent = issueIdentity(
    repository,
    await this.getParent(repository, parentTicket),
  );
  const tickets = await scriptedPages(async (page) => {
    const result = await this.listChildrenPage(repository, parentTicket, page);
    return { tickets: result.children, nextPage: result.nextPage };
  });
  const children: ParentDiscovery["children"] = [];
  for (const ticket of tickets.sort((a, b) => a.number - b.number)) {
    const blockers = await scriptedPages(async (page) => {
      const result = await this.listBlockersPage(
        repository,
        ticket.number,
        page,
      );
      return { tickets: result.blockers, nextPage: result.nextPage };
    });
    if (
      blockers.some(
        (blocker) => blocker.state === "closed" && blocker.stateReason === null,
      )
    )
      throw new OperationStopped("blocker has an unsupported terminal state");
    children.push({
      ...issueIdentity(repository, ticket),
      ...issueMarkers(ticket),
      blockers: blockers.map((blocker) => issueIdentity(repository, blocker)),
    });
  }
  return {
    parent,
    children,
    reservation: { id: reservationLabel, name: reservationLabel },
    viewer: testViewer,
  };
}

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
  const git = new LocalGitWorkspace();
  const messages: string[] = [];
  const effects: string[] = [];
  const reads: string[] = [];
  const pauses: string[] = [];
  const remoteBranches = new Map<string, string>();
  const checksFor: (
    repository: string,
    number: number,
  ) => Promise<RequiredCheck[]> = async () => [];
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
  const fixture = {
    launchDirectory,
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
      async closeTicket(repository: string, number: number): Promise<void> {
        assert.fail(`unexpected Issue closure for ${repository}#${number}`);
      },
      async commentTicket(): Promise<void> {
        assert.fail("unexpected Issue comment");
      },
      async getTicket(_repository: string, ticket: number): Promise<Ticket> {
        return { number: ticket, state: "open" as const, stateReason: null };
      },
      async listBlockersPage() {
        return { blockers: [], nextPage: null };
      },
      async addAssignee(...args: [string, number, string]) {
        void args;
        effects.push("assign");
      },
      async readViewer() {
        reads.push("viewer");
        return structuredClone(testViewer);
      },
      async getParent(repository: string, ticket: number) {
        reads.push(`${repository}#${ticket}`);
        return { number: ticket, state: "open" as const, stateReason: null };
      },
      discoverParent,
      readIssueStart,
      reserveIssue,
      async listChildrenPage(
        _repository: string,
        _ticket: number,
        page: number,
      ) {
        reads.push(`children:${page}`);
        return { children: [], nextPage: null };
      },
      readParentCompletion,
      async closeParent(
        parent: ParentObservation["parent"],
      ): Promise<ParentObservation> {
        await this.closeTicket(parent.repository, parent.number);
        return readParentCompletion.call(
          this,
          parent.repository,
          parent.number,
        );
      },
      async addLabel(...args: [string, number, string]) {
        void args;
        effects.push("reserve");
      },
    },
    codeHost: {
      async deliveryMergeFacts(
        _repository: string,
        number: number,
      ): Promise<PullRequestState & Partial<PullRequestMergeFacts>> {
        return {
          headSha:
            (await this.listPullRequests()).find((pr) => pr.number === number)
              ?.headSha ?? "b".repeat(40),
          createdAt: "2026-10-30T00:00:00Z",
          merged: false,
          mergeRequested: false,
          mergeable: "unknown",
          mergeFailure: null,
        };
      },
      observeDelivery,
      readDeliveryIssue(repository: string, ticket: number): Promise<Ticket> {
        return fixture.tracker.getTicket(repository, ticket);
      },
      createdAtFor(...args: [branch: string, number: number]) {
        void args;
        return "2026-10-30T00:00:00Z";
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
      async observeBranch(repository: string, branch: string) {
        return {
          repositoryId: "R_repo",
          headSha: await this.getRemoteBranchHead(repository, branch),
        };
      },
      async observePublication(input: PublicationQuery) {
        return {
          ...(await this.observeBranch(input.repository, input.branch)),
          candidates: await this.listPullRequests(),
        };
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
          id: `PR_${number}`,
          number,
          url: `https://github.com/${input.repository}/pull/${number}`,
          createdAt: this.createdAtFor(input.branch, number),
          branch: input.branch,
          targetBranch: input.targetBranch,
          headSha,
          state: "open",
          draft: false,
        };
        pullRequests.push(record);
        return structuredClone(record);
      },
      async observePullRequest({
        repository,
        branch,
        number,
      }: PullRequestQuery): Promise<PullRequestObservation> {
        const record = (await this.listPullRequests()).find(
          (pr) => pr.number === number,
        );
        if (!record) throw new Error("Recorded Pull Request is missing");
        const remote = await this.observeBranch(repository, branch);
        return {
          branch: remote,
          pullRequest: record,
          lastCommitSha: record.headSha,
          merge: {
            headSha: record.headSha,
            createdAt: record.createdAt,
            merged: record.state === "merged",
            mergeRequested: false,
            mergeable: "unknown",
            mergeFailure: null,
            mergeStateStatus: "UNKNOWN",
            isInMergeQueue: false,
            isMergeQueueEnabled: false,
            autoMergeEnabledAt: null,
            mergeQueueEntryId: null,
          },
          checks:
            record.state === "open" &&
            !record.draft &&
            remote.headSha === record.headSha
              ? await this.checksFor(repository, number)
              : [],
        };
      },
      async observeActionsRun({
        runId,
      }: Parameters<CodeHost["observeActionsRun"]>[0]): ReturnType<
        CodeHost["observeActionsRun"]
      > {
        assert.fail(`unexpected Actions run observation for ${runId}`);
      },
      async rerunFailedJobs({
        runId,
      }: Parameters<CodeHost["rerunFailedJobs"]>[0]): Promise<void> {
        assert.fail(`unexpected Actions rerun for ${runId}`);
      },
      checksFor,
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
  return fixture;
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
