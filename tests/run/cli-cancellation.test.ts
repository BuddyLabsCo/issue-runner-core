import assert from "node:assert/strict";
import test from "node:test";
import { validConfig } from "../support/cli-project.ts";
import {
  committed,
  deferred,
  implementationRun,
  implementationProgress,
  publish,
} from "../support/implementation-run.ts";
import { child, parentRun } from "../support/parent-run.ts";

for (const boundary of [
  "startup",
  "Probe retry",
  "Probe polling",
  "handoff polling",
  "correction",
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
    if (boundary === "Probe retry")
      fixture.state.onProbe = (assignment) =>
        publish(String(assignment.path), {});
    if (boundary === "Probe polling")
      fixture.state.onProbe = () => Promise.resolve();
    if (boundary === "handoff polling")
      fixture.state.onTask = () => Promise.resolve();
    if (boundary === "correction")
      fixture.state.onTask = (file) => publish(file, {});
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
      const saved = await fixture.snapshot();
      assert.equal(saved.corrections, boundary === "correction" ? 1 : 0);
      assert.equal(saved.probeRetries ?? 0, boundary === "Probe retry" ? 1 : 0);
      assert.deepEqual(fixture.dependencies.pauses, []);
    } finally {
      clearTimeout(deadline);
      release.resolve();
      await running;
    }
    assert.equal(fixture.state.submissions.length, submissions);
    assert.deepEqual(fixture.state.events, events);
    assert.equal(fixture.state.closedTabs.length, 0);
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

await test("an explicit matching rerun preserves a cancelled correction's consumed budget and assignment", async (t) => {
  const fixture = await implementationRun(t, { ...validConfig, agentRetry: 1 });
  fixture.state.onTask = (file) => {
    fixture.state.evidence.commits = committed().commits;
    return publish(file, {});
  };
  fixture.state.onSleep = (ms) => {
    if (ms === 2_000) fixture.controller.abort();
    return Promise.resolve();
  };
  assert.equal((await fixture.run()).summary.outcome, "cancelled");
  const saved = await fixture.snapshot();
  assert.equal(saved.corrections, 1);
  assert.ok(saved.pendingPrompt);
  const before = fixture.state.submissions.length;
  fixture.dependencies.signal = new AbortController().signal;
  fixture.state.onCorrection = (file) => publish(file, {});
  fixture.state.onSleep = (ms) =>
    ms === 250
      ? publish(saved.invocation!.path, committed())
      : Promise.resolve();
  assert.equal((await fixture.run()).summary.outcome, "incomplete");
  const resumed = fixture.state.submissions.slice(before);
  assert.match(resumed[0]!.text, /--resume/);
  assert.deepEqual(
    resumed.slice(1).map(({ text }) => text),
    [saved.pendingPrompt],
  );
  const accepted = await fixture.snapshot();
  assert.equal(accepted.phase, "implementation_completed");
  assert.equal(accepted.execution_id, saved.execution_id);
  assert.equal(accepted.worktree, saved.worktree);
  assert.equal(accepted.pr_body, saved.pr_body);
  assert.equal(accepted.corrections, 1);
  assert.deepEqual(accepted.invocation, saved.invocation);
  assert.deepEqual(accepted.superseded, saved.superseded);
  assert.equal(fixture.state.taskCount, 1);
  assert.equal(fixture.state.probeCount, 1);
  assert.equal(
    fixture.state.events.filter((event) => event === "worktree").length,
    1,
  );
});

await test("cancellation after accepted implementation retains completion for a matching rerun", async (t) => {
  const fixture = await implementationRun(t, {
    ...validConfig,
    operationRetry: 0,
  });
  fixture.state.onClose = () => Promise.reject(new Error("close unavailable"));
  fixture.dependencies.operator.pause = () => Promise.resolve("q");
  assert.equal((await fixture.run()).summary.outcome, "cancelled");
  const saved = await fixture.snapshot();
  assert.equal(saved.phase, "implementation_completed");
  const before = fixture.state.submissions.length;
  fixture.dependencies.signal = new AbortController().signal;
  fixture.dependencies.operator.pause = () => Promise.resolve("s");
  assert.equal((await fixture.run()).summary.outcome, "incomplete");
  assert.equal(fixture.state.submissions.length, before);
  assert.equal((await fixture.snapshot()).execution_id, saved.execution_id);
  assert.deepEqual((await fixture.snapshot()).result, saved.result);
});
