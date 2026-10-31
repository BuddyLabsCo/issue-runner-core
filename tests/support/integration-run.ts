/* eslint-disable @typescript-eslint/require-await -- Scripted external boundaries. */
import type { TestContext } from "node:test";
import { executeCli } from "../../src/cli.ts";
import type {
  CodeHost,
  MergeRequestResult,
  PullRequestState,
} from "../../src/run/contracts.ts";
import {
  implementationCommand,
  implementationCommit,
} from "./implementation-run.ts";
import { publicationRun } from "./publication-run.ts";
import { validConfig } from "./cli-project.ts";

export async function integrationRun(t: TestContext, config = validConfig) {
  const fixture = await publicationRun(t, config);
  const state = {
    pullRequest: {
      headSha: implementationCommit.sha,
      createdAt: "2026-10-30T00:00:00Z",
      merged: false,
      mergeRequested: false,
      mergeable: "mergeable",
      mergeFailure: null,
    } as PullRequestState,
    requests: [] as Parameters<CodeHost["requestSquashMerge"]>[0][],
    closures: 0,
    observations: 0,
    onObserve: async () => {
      /* Controlled by the scenario. */
    },
    onMerge: async (): Promise<MergeRequestResult> => {
      state.pullRequest.merged = true;
      return { outcome: "accepted" };
    },
    onClose: async () => {
      fixture.state.ticket.state = "closed";
      fixture.state.ticket.stateReason = "completed";
    },
  };
  Object.assign(fixture.dependencies.codeHost, {
    async getPullRequest() {
      state.observations++;
      await state.onObserve();
      return structuredClone(state.pullRequest);
    },
    async requestSquashMerge(
      input: Parameters<CodeHost["requestSquashMerge"]>[0],
    ) {
      state.requests.push(input);
      return state.onMerge();
    },
  });
  Object.assign(fixture.dependencies.tracker, {
    async closeTicket() {
      state.closures++;
      await state.onClose();
    },
  });
  return {
    ...fixture,
    integrationState: state,
    run: () => executeCli(implementationCommand, fixture.dependencies),
  };
}
