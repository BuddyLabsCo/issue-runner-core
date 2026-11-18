/* eslint-disable @typescript-eslint/require-await -- Scripted external boundaries. */
import assert from "node:assert/strict";
import type { TestContext } from "node:test";
import type {
  CodeHost,
  MergeRequestResult,
  RequiredCheck,
} from "../../src/run/contracts.ts";
import { child, parentDeliveryRun } from "./parent-run.ts";
import { validConfig } from "./cli-project.ts";

export async function batchRun(t: TestContext) {
  const children = [child(51), child(52), child(53)];
  const fixture = await parentDeliveryRun(t, children, {
    ...validConfig,
    issueList: [51, 52, 53],
  });
  const ready = new Set<number>();
  const { merged } = fixture;
  const requests: number[] = [];
  const state = {
    onChecks: async (number: number): Promise<RequiredCheck[]> => {
      assert.ok(number >= 81);
      return [];
    },
    onMerge: async (number: number): Promise<MergeRequestResult> => {
      merged.add(number);
      return { outcome: "accepted" };
    },
  };
  Object.assign(fixture.dependencies.codeHost, {
    async checksFor(_repository: string, number: number) {
      const checks = await state.onChecks(number);
      if (
        !checks.some(
          (check) => check.bucket === "fail" || check.bucket === "pending",
        )
      )
        ready.add(number);
      return checks;
    },
    async getPullRequest(_repository: string, number: number) {
      const pr = (await fixture.dependencies.codeHost.listPullRequests()).find(
        (pr) => pr.number === number,
      )!;
      return {
        headSha: pr.headSha,
        createdAt:
          number === 81 ? "2026-10-31T00:00:00Z" : "2026-10-30T00:00:00Z",
        merged: merged.has(number),
        mergeRequested: false,
        mergeable: "mergeable",
        mergeFailure: null,
      };
    },
    async requestSquashMerge(
      input: Parameters<CodeHost["requestSquashMerge"]>[0],
    ) {
      assert.equal(
        ready.size,
        3,
        "all Batch PRs must be CI-ready before the first merge",
      );
      requests.push(input.pullRequest);
      return state.onMerge(input.pullRequest);
    },
  });
  return { ...fixture, children, ready, merged, requests, state };
}
