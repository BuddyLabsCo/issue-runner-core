/* eslint-disable @typescript-eslint/require-await -- Scripted external boundaries. */
import assert from "node:assert/strict";
import test from "node:test";
import { AuditLog, type AuditEvent } from "../../src/audit.ts";
import {
  exhaustedLegacyCiRepair,
  failedCheck,
} from "../support/ci-repair-run.ts";

for (const interruptAfterCheckpoint of [false, true]) {
  await test(`matching recovery sends a rerun interrupted ${interruptAfterCheckpoint ? "after checkpointing and before dispatch" : "before checkpointing"}`, async (t) => {
    const fixture = await exhaustedLegacyCiRepair(t);
    const runId = "45019148280";
    const failed = { ...failedCheck, actionsRunId: runId };
    const interrupt = new AbortController();
    let reruns = 0;
    fixture.dependencies.signal = interrupt.signal;
    fixture.publicationState.onChecks = async () =>
      reruns === 0
        ? [failed]
        : [{ ...failed, state: "SUCCESS", bucket: "pass" }];
    fixture.dependencies.codeHost.observeActionsRun = async () => ({
      attempt: reruns === 0 ? 1 : 2,
      status: "completed",
      conclusion: reruns === 0 ? "failure" : "success",
    });
    fixture.dependencies.codeHost.rerunFailedJobs = async () => {
      reruns++;
    };
    const append = Reflect.get(AuditLog.prototype, "append");
    let startingRerun = false;
    const audit = t.mock.method(
      AuditLog.prototype,
      "append",
      async function (this: AuditLog, event: AuditEvent): Promise<void> {
        await append.call(this, event);
        if (
          event.operation === "rerun_failed_actions_jobs" &&
          event.result === "started"
        ) {
          startingRerun = true;
          if (!interruptAfterCheckpoint) interrupt.abort();
        } else if (
          startingRerun &&
          event.operation === "save_implementation_checkpoint" &&
          event.result === "succeeded"
        ) {
          const saved = await fixture.snapshot();
          assert.equal(
            saved.publication?.ciRepair?.attempts.at(-1)?.actionsRerun?.runId,
            runId,
          );
          interrupt.abort();
        }
      },
    );
    assert.equal((await fixture.run()).summary.outcome, "cancelled");
    assert.equal(reruns, 0);
    audit.mock.restore();
    fixture.dependencies.signal = new AbortController().signal;
    assert.match(
      (await fixture.run()).summary.tickets![0]!.detail,
      /CI-ready/u,
    );
    assert.equal(reruns, 1);
    assert.equal(fixture.repairs.tasks.length, 1);
    assert.equal(fixture.dependencies.pauses.length, 0);
  });
}
