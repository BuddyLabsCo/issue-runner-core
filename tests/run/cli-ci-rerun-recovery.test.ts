/* eslint-disable @typescript-eslint/require-await -- Scripted external boundaries. */
import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";
import { AuditLog, type AuditEvent } from "../../src/audit.ts";
import {
  exhaustedLegacyCiRepair,
  failedCheck,
} from "../support/ci-repair-run.ts";
import { deferred, publish } from "../support/implementation-run.ts";

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

await test(
  "matching recovery sends a rerun from the checkpoint saved while dispatch is gated",
  { timeout: 10_000 },
  async (t) => {
    const fixture = await exhaustedLegacyCiRepair(t);
    const runId = "45019148280";
    const failed = { ...failedCheck, actionsRunId: runId };
    let reruns = 0;
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

    const paused = deferred<void>();
    const answer = deferred<string>();
    const pause = fixture.dependencies.operator.pause.bind(
      fixture.dependencies.operator,
    );
    fixture.dependencies.operator.pause = async (message) => {
      assert.match(message, /Audit write failed/u);
      paused.resolve();
      return answer.promise;
    };
    let dispatchStarted = false;
    let auditFailed = false;
    const append = Reflect.get(AuditLog.prototype, "append");
    const audit = t.mock.method(
      AuditLog.prototype,
      "append",
      async function (this: AuditLog, event: AuditEvent): Promise<void> {
        if (
          event.operation === "rerun_failed_actions_jobs" &&
          event.result === "started"
        )
          dispatchStarted = true;
        if (
          dispatchStarted &&
          !auditFailed &&
          event.operation === "save_implementation_checkpoint" &&
          event.result === "succeeded"
        ) {
          auditFailed = true;
          throw new Error("Checkpoint audit unavailable");
        }
        await append.call(this, event);
      },
    );
    fixture.dependencies.signal = new AbortController().signal;
    const running = fixture.run();
    const saved = await (async () => {
      try {
        await Promise.race([
          paused.promise,
          running.then((result) =>
            assert.fail(`Run ended before pause: ${JSON.stringify(result)}`),
          ),
        ]);
        assert.equal(reruns, 0);
        return await fixture.snapshot();
      } finally {
        answer.resolve("q");
        await running;
        audit.mock.restore();
      }
    })();
    assert.equal((await running).summary.outcome, "cancelled");
    assert.equal(reruns, 0);

    await publish(
      path.join(fixture.directory, "recovery", `${saved.input_hash}-50.json`),
      saved,
    );
    fixture.dependencies.signal = new AbortController().signal;
    fixture.dependencies.operator.pause = pause;
    assert.match(
      (await fixture.run()).summary.tickets![0]!.detail,
      /CI-ready/u,
    );
    assert.equal(reruns, 1);
    assert.equal(fixture.repairs.tasks.length, 1);
  },
);
