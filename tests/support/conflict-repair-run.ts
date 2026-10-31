/* eslint-disable @typescript-eslint/require-await -- Scripted external boundaries. */
import assert from "node:assert/strict";
import type { TestContext } from "node:test";
import type {
  CodeHost,
  MergeRequestResult,
  PullRequestState,
} from "../../src/run/contracts.ts";
import { executeCli } from "../../src/cli.ts";
import { ciRepairRun } from "./ci-repair-run.ts";
import { validConfig } from "./cli-project.ts";
import { deliveryCommand as implementationCommand } from "./implementation-run.ts";

export async function conflictRepairRun(
  t: TestContext,
  config: Parameters<typeof ciRepairRun>[1] = validConfig,
) {
  const fixture = await ciRepairRun(t, config, "conflict");
  const state = {
    merged: false,
    mergeRequested: false,
    mergeable: "unknown" as PullRequestState["mergeable"],
    requests: [] as Parameters<CodeHost["requestSquashMerge"]>[0][],
    onMerge: async (): Promise<MergeRequestResult> => {
      if (fixture.publicationState.pushes === 1)
        return {
          outcome: "conflict",
          error: new Error("Merge conflict in README"),
        };
      state.merged = true;
      return { outcome: "accepted" };
    },
    includesTarget: true,
  };
  fixture.publicationState.onChecks = async () => [];
  fixture.dependencies.codeHost.getPullRequest = async () => ({
    headSha: fixture.publicationState.pullRequests[0]!.headSha,
    createdAt: "2026-10-30T00:00:00Z",
    merged: state.merged,
    mergeRequested: state.mergeRequested,
    mergeable: state.mergeable,
    mergeFailure: null,
  });
  Object.assign(fixture.dependencies.codeHost, {
    async requestSquashMerge(
      input: Parameters<CodeHost["requestSquashMerge"]>[0],
    ) {
      state.requests.push(input);
      assert.equal(input.pullRequest, 81);
      return state.onMerge();
    },
  });
  Object.assign(fixture.dependencies.tracker, {
    async closeTicket() {
      assert.equal(state.merged, true);
      fixture.state.ticket.state = "closed";
      fixture.state.ticket.stateReason = "completed";
    },
  });
  const inspect = fixture.dependencies.gitWorkspace.inspect.bind(
    fixture.dependencies.gitWorkspace,
  );
  fixture.dependencies.gitWorkspace.inspect = async (input) => {
    const evidence = await inspect(input);
    if (
      input?.base === "a".repeat(40) &&
      evidence.branch.includes("conflict-repair") &&
      state.includesTarget
    )
      evidence.base = input.base;
    return evidence;
  };
  return {
    ...fixture,
    conflictState: state,
    run: () => executeCli(implementationCommand, fixture.dependencies),
  };
}
