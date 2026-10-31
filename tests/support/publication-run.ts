/* eslint-disable @typescript-eslint/require-await -- Scripted external boundaries. */
import assert from "node:assert/strict";
import type { TestContext } from "node:test";
import { executeCli } from "../../src/cli.ts";
import type {
  PullRequestRecord,
  RequiredCheck,
} from "../../src/run/contracts.ts";
import {
  implementationCommand,
  implementationRun,
} from "./implementation-run.ts";
import { validConfig } from "./cli-project.ts";

export async function publicationRun(t: TestContext, config = validConfig) {
  const fixture = await implementationRun(t, config);
  let now = 0;
  const state = {
    branches: new Map<string, string>(),
    pullRequests: [] as PullRequestRecord[],
    checks: [] as RequiredCheck[],
    pushes: 0,
    creations: 0,
    discoveries: [] as number[],
    onPush: async (branch: string, head: string) => {
      state.branches.set(branch, head);
    },
    onCreate: async () => {
      /* The scenario may simulate a lost response. */
    },
    onChecks: async () => state.checks,
  };
  fixture.dependencies.clock.now = () => new Date(now);
  const sleep = fixture.dependencies.clock.sleep.bind(
    fixture.dependencies.clock,
  );
  fixture.dependencies.clock.sleep = async (ms) => {
    now += ms;
    await sleep(ms);
  };
  fixture.dependencies.gitWorkspace.push = async (_worktree, branch, head) => {
    const saved = await fixture.snapshot();
    assert.equal(saved.publication?.phase, "pending_push");
    assert.equal(saved.publication.headSha, head);
    state.pushes++;
    await state.onPush(branch, head);
  };
  const codeHost = fixture.dependencies.codeHost;
  codeHost.getRemoteBranchHead = async (_repo, branch) =>
    state.branches.get(branch) ?? null;
  codeHost.listPullRequests = async () => structuredClone(state.pullRequests);
  codeHost.createPullRequest = async (input) => {
    const saved = await fixture.snapshot();
    assert.equal(saved.publication?.phase, "pending_pr");
    assert.equal(saved.publication.creationAttempted, true);
    assert.equal(input.title, saved.pr_title);
    assert.equal(input.body, saved.pr_body);
    state.creations++;
    const number = state.creations + 80;
    const pullRequest: PullRequestRecord = {
      number,
      url: `https://github.com/owner/repo/pull/${number}`,
      branch: input.branch,
      targetBranch: input.targetBranch,
      headSha: state.branches.get(input.branch)!,
      state: "open",
    };
    state.pullRequests.push(pullRequest);
    await state.onCreate();
    return { number, url: pullRequest.url };
  };
  codeHost.getRequiredChecks = async () => {
    state.discoveries.push(now);
    return state.onChecks();
  };
  return {
    ...fixture,
    publicationState: state,
    run: () =>
      executeCli(
        [...implementationCommand, "--no-auto-merge"],
        fixture.dependencies,
      ),
  };
}
