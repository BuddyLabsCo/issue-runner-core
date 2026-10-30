/* eslint-disable @typescript-eslint/require-await -- Scripted external contracts retain asynchronous signatures. */
import assert from "node:assert/strict";
import { LocalGitWorkspace } from "../../src/adapters/git-workspace.ts";

export function createCliDependencies(launchDirectory: string) {
  const git = new LocalGitWorkspace("host-secret");
  const messages: string[] = [];
  const effects: string[] = [];
  const reads: string[] = [];
  const pauses: string[] = [];
  return {
    launchDirectory,
    env: { TRACKER_TOKEN: "tracker-secret", HOST_TOKEN: "host-secret" },
    messages,
    effects,
    reads,
    pauses,
    tracker: {
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
      async resolveTargetBranch(repository: string) {
        reads.push(`branch:${repository}`);
        return "default-branch";
      },
    },
    gitWorkspace: {
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
