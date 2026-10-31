/* eslint-disable @typescript-eslint/require-await -- Scripted external boundaries. */
import assert from "node:assert/strict";
import test from "node:test";
import { executeCli } from "../../src/cli.ts";
import { ciRepairRun } from "../support/ci-repair-run.ts";
import { conflictRepairRun } from "../support/conflict-repair-run.ts";
import {
  deliveryCommand,
  implementationCommit,
} from "../support/implementation-run.ts";

for (const kind of ["ci", "conflict"] as const) {
  for (const interruption of ["assignment", "push"] as const) {
    await test(`an exact merged PR stops recovery after an interrupted ${kind} repair ${interruption} without continuation or another push`, async (t) => {
      const fixture = await (kind === "ci" ? ciRepairRun : conflictRepairRun)(
        t,
      );
      const state = fixture.publicationState;
      let merged = false;
      fixture.dependencies.codeHost.getPullRequest = async () => ({
        headSha: state.pullRequests[0]!.headSha,
        createdAt: "2026-10-30T00:00:00Z",
        merged,
        mergeRequested: false,
        mergeable: "mergeable",
        mergeFailure: null,
      });
      Object.assign(fixture.dependencies.tracker, {
        closeTicket: async () => {
          assert.equal(merged, true);
          fixture.state.ticket.state = "closed";
          fixture.state.ticket.stateReason = "completed";
        },
      });
      const run = () => executeCli(deliveryCommand, fixture.dependencies);
      const task = fixture.repairs.onTask;
      if (interruption === "assignment")
        fixture.repairs.onTask = async () => fixture.controller.abort();
      else {
        const push = state.onPush;
        state.onPush = async (branch, head) => {
          await push(branch, head);
          if (state.pushes === 2) fixture.controller.abort();
        };
      }
      assert.equal((await run()).summary.outcome, "cancelled");
      const before = await fixture.snapshot();
      assert.equal(
        before.publication![kind === "ci" ? "ciRepair" : "conflictRepair"]!
          .attempts.length,
        1,
      );
      assert.equal(fixture.repairs.tasks.length, 1);
      state.pullRequests[0]!.state = "merged";
      const mergedHead = state.pullRequests[0]!.headSha;
      merged = true;
      fixture.repairs.onTask = task;
      fixture.dependencies.signal = new AbortController().signal;
      state.onPush = async (branch, head) => {
        state.branches.set(branch, head);
      };
      fixture.dependencies.operator.pause = async () => "q";
      const result = await run();
      assert.equal(result.summary.outcome, "succeeded", JSON.stringify(result));
      assert.equal(fixture.repairs.continuations.length, 0);
      assert.equal(fixture.repairs.tasks.length, 1);
      assert.equal(fixture.repairs.probes.length, 1);
      assert.equal(state.pushes, interruption === "assignment" ? 1 : 2);
      assert.equal(state.creations, 1);
      assert.equal(state.branches.get(before.branch), mergedHead);
      const after = await fixture.snapshot();
      assert.equal(after.publication!.merge!.headSha, mergedHead);
      assert.equal(after.publication!.phase, "delivered");
      assert.equal(fixture.state.cleanup.length, 2);
    });
  }
}

for (const moment of ["discovery", "repair_push"] as const) {
  await test(`a merge observed during ${moment} stops check polling and repair writes at the merged head`, async (t) => {
    const fixture = await ciRepairRun(t);
    const state = fixture.publicationState;
    let merged = false;
    const merge = () => {
      merged = true;
      state.pullRequests[0]!.state = "merged";
    };
    fixture.dependencies.codeHost.getPullRequest = async () => ({
      headSha: implementationCommit.sha,
      createdAt: "2026-10-30T00:00:00Z",
      merged,
      mergeRequested: false,
      mergeable: "mergeable",
      mergeFailure: null,
    });
    Object.assign(fixture.dependencies.tracker, {
      closeTicket: async () => {
        assert.equal(merged, true);
        fixture.state.ticket.state = "closed";
        fixture.state.ticket.stateReason = "completed";
      },
    });
    if (moment === "discovery")
      fixture.state.onSleep = async (ms) => {
        if (ms === 30_000) merge();
      };
    else
      fixture.state.onClose = async () => {
        if (fixture.state.closedTabs.length === 2) merge();
      };
    state.onPush = async (branch, head) => {
      state.branches.set(branch, head);
    };
    fixture.dependencies.operator.pause = async () => "q";
    const result = await executeCli(deliveryCommand, fixture.dependencies);
    assert.equal(result.summary.outcome, "succeeded", JSON.stringify(result));
    assert.equal(state.pushes, 1);
    assert.equal(state.creations, 1);
    assert.equal(state.discoveries.length, moment === "discovery" ? 0 : 1);
    assert.equal(fixture.repairs.continuations.length, 0);
    assert.equal(fixture.repairs.tasks.length, moment === "discovery" ? 0 : 1);
    assert.equal(fixture.repairs.probes.length, moment === "discovery" ? 0 : 1);
    const saved = await fixture.snapshot();
    assert.equal(state.branches.get(saved.branch), implementationCommit.sha);
    assert.equal(saved.publication!.merge!.headSha, implementationCommit.sha);
    assert.equal(saved.publication!.phase, "delivered");
    assert.equal(fixture.state.cleanup.length, moment === "discovery" ? 1 : 2);
  });
}
