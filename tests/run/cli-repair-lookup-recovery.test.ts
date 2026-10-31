import assert from "node:assert/strict";
import { access } from "node:fs/promises";
import test from "node:test";
import { ciRepairRun, repairCommit } from "../support/ci-repair-run.ts";
import { validConfig } from "../support/cli-project.ts";
import { conflictRepairRun } from "../support/conflict-repair-run.ts";

for (const kind of ["ci", "conflict"] as const) {
  for (const recovery of ["transient", "retry", "cancel"] as const) {
    await test(`pending ${kind} repair push lookup supports ${recovery} recovery without repeating the push`, async (t) => {
      const fixture = await (kind === "ci" ? ciRepairRun : conflictRepairRun)(
        t,
        {
          ...validConfig,
          operationRetry: 1,
          operationRetryDelay: [2],
        },
      );
      const state = fixture.publicationState;
      const push = state.onPush;
      state.onPush = async (branch, head) => {
        await push(branch, head);
        if (head === repairCommit.sha) fixture.controller.abort();
      };
      assert.equal((await fixture.run()).summary.outcome, "cancelled");
      const before = await fixture.snapshot();
      const key = kind === "ci" ? "ciRepair" : "conflictRepair";
      assert.equal(
        before.publication![key]!.attempts[0]!.pendingPush,
        repairCommit.sha,
      );
      const lookup = fixture.dependencies.codeHost.getRemoteBranchHead.bind(
        fixture.dependencies.codeHost,
      );
      let lookups = 0;
      const failure = "temporary publication lookup failure";
      fixture.dependencies.codeHost.getRemoteBranchHead = async (...args) => {
        if (++lookups <= (recovery === "transient" ? 1 : 2))
          throw new Error(failure);
        return lookup(...args);
      };
      let pauses = 0;
      fixture.dependencies.operator.pause = async (message) => {
        assert.match(
          message,
          /Operation failed: temporary publication lookup failure/u,
        );
        assert.equal(lookups, 2);
        const saved = await fixture.snapshot();
        const exhausted = Object.values(saved.operations ?? {}).find(
          (operation) => operation.error === failure,
        );
        assert.equal(exhausted?.consumed, 2);
        assert.equal(state.pushes, 2);
        pauses++;
        return recovery === "retry" ? "" : "q";
      };
      fixture.dependencies.signal = new AbortController().signal;
      const sleeps = fixture.state.sleeps.length;
      const result = await fixture.run();
      if (recovery === "cancel") {
        assert.equal(result.summary.outcome, "cancelled");
        fixture.dependencies.signal = new AbortController().signal;
        assert.equal((await fixture.run()).summary.outcome, "cancelled");
        assert.equal(
          lookups,
          2,
          "Restart must preserve the exhausted lookup budget",
        );
        await access(before.worktree);
        await access(before.publication![key]!.attempts[0]!.worktree);
      } else if (kind === "ci")
        assert.match(result.summary.reasons.join(" "), /CI-ready/u);
      else
        assert.equal(
          result.summary.outcome,
          "succeeded",
          JSON.stringify(result),
        );
      assert.equal(fixture.state.sleeps[sleeps], 2_000);
      assert.equal(
        pauses,
        recovery === "transient" ? 0 : recovery === "retry" ? 1 : 2,
      );
      assert.equal(state.pushes, 2);
      assert.equal(fixture.repairs.tasks.length, 1);
      assert.equal(fixture.repairs.continuations.length, 0);
      const saved = await fixture.snapshot();
      assert.equal(
        saved.publication![key]!.attempts[0]!.pushed,
        recovery === "cancel" ? undefined : true,
      );
      assert.deepEqual(
        saved.publication!.pullRequest,
        before.publication!.pullRequest,
      );
    });
  }
}
