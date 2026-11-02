import assert from "node:assert/strict";
import test from "node:test";
import { access } from "node:fs/promises";
import { validConfig } from "../support/cli-project.ts";
import {
  deferred,
  implementationRun,
  implementationProgress,
  publish,
} from "../support/implementation-run.ts";
import { child, parentRun } from "../support/parent-run.ts";

for (const boundary of [
  "startup",
  "Probe polling",
  "handoff polling",
  "operation backoff",
] as const) {
  await test(`cancellation interrupts unresolved ${boundary} without later input or owned resources`, async (t) => {
    const fixture = await implementationRun(t);
    const entered = deferred<void>();
    const release = deferred<void>();
    let waitSignal: AbortSignal | undefined;
    const sleep = fixture.dependencies.clock.sleep.bind(
      fixture.dependencies.clock,
    );
    fixture.dependencies.clock.sleep = (ms, signal?: AbortSignal) => {
      waitSignal = signal;
      return sleep(ms);
    };
    if (boundary === "Probe polling")
      fixture.state.onProbe = () => Promise.resolve();
    if (boundary === "handoff polling")
      fixture.state.onTask = () => Promise.resolve();
    let operationAttempts = 0;
    if (boundary === "operation backoff")
      fixture.dependencies.gitWorkspace.inspect = () => {
        operationAttempts += 1;
        return Promise.reject(new Error("Git observation unavailable"));
      };
    fixture.state.onSleep = (ms) => {
      if (ms === 10_000 && boundary !== "startup") return Promise.resolve();
      entered.resolve();
      return release.promise;
    };
    const running = fixture.run();
    let deadline: ReturnType<typeof setTimeout> | undefined;
    let submissions: number;
    let events: string[];
    try {
      await entered.promise;
      submissions = fixture.state.submissions.length;
      events = [...fixture.state.events];
      fixture.controller.abort();
      const result = await Promise.race([
        running,
        new Promise<never>((_resolve, reject) => {
          deadline = setTimeout(
            () => reject(new Error(`cancellation still waits for ${boundary}`)),
            1_000,
          );
        }),
      ]);
      assert.equal(result.summary.outcome, "cancelled");
      assert.equal(result.exitCode, 1);
      assert.equal(waitSignal?.aborted, true);
      assert.deepEqual(fixture.dependencies.pauses, []);
    } finally {
      clearTimeout(deadline);
      release.resolve();
      await running;
    }
    assert.equal(fixture.state.submissions.length, submissions);
    assert.deepEqual(fixture.state.events, events);
    assert.equal(fixture.state.closedTabs.length, 0);
    await assert.rejects(access(fixture.state.gitConfigs[0]!));
    if (boundary === "operation backoff") assert.equal(operationAttempts, 1);
  });
}

await test("q in a sibling's non-Agent pause cancels startup without waiting for its delay", async (t) => {
  const fixture = await parentRun(t, [child(51), child(52)], {
    ...validConfig,
    operationRetry: 0,
  });
  const entered = deferred<void>();
  const release = deferred<void>();
  fixture.dependencies.clock.sleep = () => {
    entered.resolve();
    return release.promise;
  };
  const inspect = fixture.dependencies.gitWorkspace.inspect.bind(
    fixture.dependencies.gitWorkspace,
  );
  fixture.dependencies.gitWorkspace.inspect = async (input) => {
    if (input.worktree.endsWith("ticket-51")) {
      await entered.promise;
      throw new Error("Git unavailable before dispatch");
    }
    return inspect(input);
  };
  fixture.dependencies.operator.pause = (message) => {
    assert.match(message, /Git unavailable before dispatch/);
    return Promise.resolve("q");
  };
  const submissions: string[] = [];
  const submit = fixture.dependencies.terminalPlugin.submitText.bind(
    fixture.dependencies.terminalPlugin,
  );
  fixture.dependencies.terminalPlugin.submitText = (tab, text) => {
    submissions.push(text);
    return submit(tab, text);
  };
  const running = fixture.run();
  let deadline: ReturnType<typeof setTimeout> | undefined;
  try {
    const result = await Promise.race([
      running,
      new Promise<never>((_resolve, reject) => {
        deadline = setTimeout(
          () => reject(new Error("Batch still waits for sibling startup")),
          1_000,
        );
      }),
    ]);
    assert.equal(result.summary.outcome, "cancelled");
    assert.equal(fixture.controller.signal.aborted, false);
    assert.equal(
      (await implementationProgress(fixture.directory, 51)).phase,
      "reserved",
    );
    assert.equal(
      (await implementationProgress(fixture.directory, 52)).phase,
      "probing",
    );
  } finally {
    clearTimeout(deadline);
    release.resolve();
    await running;
  }
  assert.deepEqual(submissions, [validConfig.agents.implement.start]);
  assert.deepEqual(fixture.dispatched, []);
});

for (const boundary of ["Probe", "handoff"] as const) {
  await test(`cancellation after invalid ${boundary} publication prevents feedback`, async (t) => {
    const fixture = await implementationRun(t);
    if (boundary === "Probe")
      fixture.state.onProbe = async (assignment) => {
        await publish(String(assignment.path), {});
        fixture.controller.abort();
      };
    else
      fixture.state.onTask = async (file) => {
        await publish(file, {});
        fixture.controller.abort();
      };
    assert.equal((await fixture.run()).summary.outcome, "cancelled");
    assert.equal(
      fixture.state.submissions.length,
      boundary === "Probe" ? 2 : 3,
    );
    assert.deepEqual((await fixture.snapshot()).superseded, []);
    assert.equal(fixture.state.closedTabs.length, 0);
  });
}

await test("cancellation after accepted implementation retains completion for a matching rerun", async (t) => {
  const fixture = await implementationRun(t, {
    ...validConfig,
    operationRetry: 1,
  });
  fixture.state.onClose = () => Promise.reject(new Error("close unavailable"));
  fixture.dependencies.operator.pause = (message) => {
    assert.match(message, /close unavailable/);
    fixture.dependencies.pauses.push(message);
    return Promise.resolve("q");
  };
  assert.equal((await fixture.run()).summary.outcome, "cancelled");
  const saved = await fixture.snapshot();
  assert.equal(saved.phase, "implementation_completed");
  assert.equal(fixture.state.closedTabs.length, 2);
  assert.equal(new Set(fixture.state.closedTabs).size, 1);
  assert.equal(fixture.dependencies.pauses.length, 1);
  assert.equal(saved.cleanup, undefined);
  assert.deepEqual(fixture.state.cleanup, []);
  await access(saved.invocation!.path);
  await access(saved.worktree);
  const before = fixture.state.submissions.length;
  fixture.dependencies.signal = new AbortController().signal;
  fixture.dependencies.operator.pause = () => Promise.resolve("s");
  assert.equal((await fixture.run()).summary.outcome, "incomplete");
  assert.equal(fixture.state.submissions.length, before);
  assert.equal((await fixture.snapshot()).execution_id, saved.execution_id);
  assert.deepEqual((await fixture.snapshot()).result, saved.result);
});
