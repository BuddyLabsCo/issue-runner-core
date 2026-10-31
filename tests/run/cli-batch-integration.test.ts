/* eslint-disable @typescript-eslint/require-await -- Scripted external boundaries. */
import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";
import type {
  CodeHost,
  MergeRequestResult,
  RequiredCheck,
} from "../../src/run/contracts.ts";
import { child, parentRun } from "../support/parent-run.ts";
import { validConfig } from "../support/cli-project.ts";
import { implementationProgress } from "../support/implementation-run.ts";

async function batchRun(t: TestContext) {
  const children = [child(51), child(52), child(53)];
  const fixture = await parentRun(t, children, {
    ...validConfig,
    issueList: [51, 52, 53],
  });
  const ready = new Set<number>();
  const merged = new Set<number>();
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
    async getRequiredChecks(_repository: string, number: number) {
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
  Object.assign(fixture.dependencies.tracker, {
    async closeTicket(_repository: string, number: number) {
      const ticket = children.find((ticket) => ticket.number === number)!;
      ticket.state = "closed";
      ticket.stateReason = "completed";
    },
  });
  return { ...fixture, children, ready, merged, requests, state };
}

await test("Batch integration waits for every PR, then squashes by creation time and PR number", async (t) => {
  const fixture = await batchRun(t);
  const result = await fixture.run(["--issue"]);
  assert.deepEqual(fixture.requests, [82, 83, 81], JSON.stringify(result));
  assert.equal(result.summary.outcome, "succeeded");
  assert.equal(
    fixture.children.every((ticket) => ticket.stateReason === "completed"),
    true,
  );
  for (const number of [51, 52, 53])
    assert.equal(
      (await implementationProgress(fixture.directory, number)).publication
        ?.phase,
      "delivered",
    );
});

await test("one failed required check holds the entire Batch before integration", async (t) => {
  const fixture = await batchRun(t);
  fixture.state.onChecks = async (number) =>
    number === 82
      ? [{ name: "test", state: "FAILURE", link: "", bucket: "fail" }]
      : [];
  assert.equal((await fixture.run(["--issue"])).summary.outcome, "incomplete");
  assert.deepEqual(fixture.requests, []);
  assert.equal(
    fixture.children.every((ticket) => ticket.state === "open"),
    true,
  );
});

await test("a later merge rejection retains earlier confirmed delivery without rollback or overtaking", async (t) => {
  const fixture = await batchRun(t);
  fixture.state.onMerge = async (number) => {
    if (number === 83)
      return { outcome: "rejected", error: new Error("merge forbidden") };
    fixture.merged.add(number);
    return { outcome: "accepted" };
  };
  fixture.dependencies.operator.pause = async (message) => {
    assert.match(message, /merge forbidden/u);
    return "q";
  };
  assert.equal((await fixture.run(["--issue"])).summary.outcome, "cancelled");
  assert.deepEqual(fixture.requests, [82, 83, 83]);
  const saved = await Promise.all(
    [51, 52, 53].map((number) =>
      implementationProgress(fixture.directory, number),
    ),
  );
  assert.equal(
    saved.filter((progress) => progress.publication?.phase === "delivered")
      .length,
    1,
  );
});
