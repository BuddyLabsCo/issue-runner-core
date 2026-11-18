/* eslint-disable @typescript-eslint/require-await -- Scripted external boundaries. */
import assert from "node:assert/strict";
import test from "node:test";
import { conflictRepairRun } from "../support/conflict-repair-run.ts";
import { integrationRun } from "../support/integration-run.ts";
import { validConfig } from "../support/cli-project.ts";

for (const reason of ["completed", "not_planned"] as const) {
  await test(`a ${reason} Issue observed at the closure gate is reconciled without a close request`, async (t) => {
    const config = { ...validConfig, targetBranch: "release" };
    const fixture = await integrationRun(t, config);
    const { codeHost, tracker } = fixture.dependencies;
    const labels = ["ready-for-agent", "Docs"];
    codeHost.readDeliveryIssue = async () =>
      structuredClone(fixture.state.ticket);
    const inspect = tracker.getTicket.bind(tracker);
    tracker.getTicket = async () => {
      if (fixture.integrationState.pullRequest.merged) {
        fixture.state.ticket.state = "closed";
        fixture.state.ticket.stateReason = reason;
        fixture.state.ticket.labels = labels;
      }
      return inspect();
    };

    const result = await fixture.run();
    const publication = (await fixture.snapshot()).publication!;
    assert.equal(fixture.integrationState.observations, 2);
    assert.equal(fixture.integrationState.closures, 0);
    assert.equal(
      result.summary.outcome,
      reason === "completed" ? "succeeded" : "incomplete",
    );
    assert.equal(
      publication.phase,
      reason === "completed" ? "delivered" : "merged",
    );
    assert.deepEqual(
      publication.deliveryLabels,
      reason === "completed" ? labels : undefined,
    );
  });
}

for (const interruptedAt of [
  "conflict-target fetch",
  "repair Worktree creation",
]) {
  await test(`resuming interrupted ${interruptedAt} waits for a queued PR without dispatching repair`, async (t) => {
    const fixture = await conflictRepairRun(t);
    const { gitWorkspace, codeHost } = fixture.dependencies;
    const fetch = gitWorkspace.fetchTargetBranch.bind(gitWorkspace);
    let fetches = 0;
    fixture.conflictState.mergeable = "conflicting";
    gitWorkspace.fetchTargetBranch = async () => {
      if (++fetches === 2 && interruptedAt === "conflict-target fetch")
        fixture.controller.abort();
      return fetch();
    };
    const create = gitWorkspace.createWorktree.bind(gitWorkspace);
    let repairWorktrees = 0;
    gitWorkspace.createWorktree = async (input) => {
      await create(input);
      if (
        input.branch.includes("conflict-repair") &&
        ++repairWorktrees === 1 &&
        interruptedAt === "repair Worktree creation"
      )
        fixture.controller.abort();
    };

    assert.equal((await fixture.run()).summary.outcome, "cancelled");
    const interrupted = (await fixture.snapshot()).publication!;
    assert.equal(interrupted.phase, "conflict_repair");
    const retained = interrupted.conflictRepair?.attempts ?? [];
    assert.equal(
      retained.length,
      interruptedAt === "conflict-target fetch" ? 0 : 1,
    );
    assert.equal(retained[0]?.invocation, undefined);
    const worktreesBeforeResume = repairWorktrees;

    fixture.dependencies.signal = new AbortController().signal;
    fixture.conflictState.mergeable = "mergeable";
    fixture.conflictState.mergeRequested = true;
    const observe = codeHost.observePullRequest.bind(codeHost);
    codeHost.observePullRequest = async (input) => {
      const result = await observe(input);
      if (!result.merge.merged) {
        result.merge.isInMergeQueue = true;
        result.merge.mergeRequested = true;
      }
      return result;
    };
    let waitedForQueue = false;
    fixture.state.onSleep = async () => {
      if ((await fixture.snapshot()).publication?.phase !== "merge_requested")
        return;
      waitedForQueue = true;
      fixture.conflictState.merged = true;
    };
    const result = await fixture.run();
    assert.equal(repairWorktrees, worktreesBeforeResume);
    assert.equal(fixture.publicationState.pushes, 1);
    assert.equal(fixture.repairs.tasks.length, 0);
    assert.equal(fixture.conflictState.requests.length, 0);
    assert.ok(waitedForQueue);
    assert.equal(result.summary.outcome, "succeeded");
    const final = (await fixture.snapshot()).publication?.conflictRepair;
    assert.equal(final?.consumed ?? 0, 0);
    assert.deepEqual(final?.attempts ?? [], retained);
  });
}

for (const outcome of ["conflict", "rejected"] as const) {
  await test(`a PR closed during ${outcome} reconciliation never starts conflict repair`, async (t) => {
    const fixture = await conflictRepairRun(t);
    const { codeHost, gitWorkspace, operator } = fixture.dependencies;
    const create = gitWorkspace.createWorktree.bind(gitWorkspace);
    let repairWorktrees = 0;
    gitWorkspace.createWorktree = (input) => {
      if (input.branch.includes("conflict-repair")) repairWorktrees++;
      return create(input);
    };
    let closed = false;
    fixture.conflictState.onMerge = async () => {
      closed = true;
      return { outcome, error: new Error("Merge attempt failed") };
    };
    const observe = codeHost.deliveryMergeFacts.bind(codeHost);
    codeHost.deliveryMergeFacts = async (repository, number) => ({
      ...(await observe(repository, number)),
      ...(closed
        ? {
            mergeFailure: "Pull Request 81 closed without merging",
            mergeStateStatus: "DIRTY",
          }
        : {}),
    });
    let pause: string | undefined;
    operator.pause = async (message) => {
      pause = message;
      return "q";
    };

    const result = await fixture.run();
    assert.equal(repairWorktrees, 0);
    assert.equal(fixture.repairs.tasks.length, 0);
    assert.equal(fixture.conflictState.requests.length, 1);
    assert.equal(result.summary.outcome, "cancelled");
    assert.match(pause ?? "", /Pull Request 81 closed without merging/u);
  });
}
