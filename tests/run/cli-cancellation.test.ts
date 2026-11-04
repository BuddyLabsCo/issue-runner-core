/* eslint-disable @typescript-eslint/require-await -- Scripted external boundaries. */
import { executeCli } from "../../src/cli.ts";
import { implementationCommand } from "../support/implementation-run.ts";
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
    if (boundary === "startup") {
      const start = fixture.dependencies.terminalPlugin.execute.bind(
        fixture.dependencies.terminalPlugin,
      );
      fixture.dependencies.terminalPlugin.execute = async (tab, command) => {
        await start(tab, command);
        waitSignal = fixture.state.tabOptions[0]!.signal;
        entered.resolve();
        await release.promise;
        return undefined;
      };
    }
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

await test("q in a sibling's non-Agent pause cancels pending readiness", async (t) => {
  const fixture = await parentRun(t, [child(51), child(52)], {
    ...validConfig,
    operationRetry: 0,
  });
  const entered = deferred<void>();
  const paused = deferred<void>();
  const release = deferred<void>();
  const start = fixture.dependencies.terminalPlugin.execute.bind(
    fixture.dependencies.terminalPlugin,
  );
  fixture.dependencies.terminalPlugin.execute = async (tab, command) => {
    await start(tab, command);
    entered.resolve();
    await release.promise;
    return undefined;
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
    paused.resolve();
    return Promise.resolve("q");
  };
  const submissions: string[] = [];
  const submit = fixture.dependencies.terminalPlugin.onInput.bind(
    fixture.dependencies.terminalPlugin,
  );
  fixture.dependencies.terminalPlugin.onInput = (tab, text) => {
    submissions.push(text);
    return submit(tab, text);
  };
  const running = fixture.run();
  const ended = running.then(() => {
    throw new Error("Run ended before startup and Operator Pause");
  });
  const timedOut = deferred<never>();
  const deadline = setTimeout(
    () => timedOut.reject(new Error("Cancellation scenario did not settle")),
    30_000,
  );
  try {
    await Promise.race([
      Promise.all([entered.promise, paused.promise]),
      ended,
      timedOut.promise,
    ]);
    const result = await Promise.race([running, timedOut.promise]);
    assert.equal(result.summary.outcome, "cancelled");
    assert.equal(fixture.controller.signal.aborted, false);
    assert.equal(
      (await implementationProgress(fixture.directory, 51)).phase,
      "reserved",
    );
    assert.equal(
      (await implementationProgress(fixture.directory, 52)).phase,
      "worktree_created",
    );
  } finally {
    clearTimeout(deadline);
    entered.resolve();
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

await test("cancellation leaves a pending enhancement factory behind and cleans its eventual instance", async (t) => {
  const fixture = await implementationRun(t);
  const entered = deferred<void>();
  const factory = deferred<import("../../src/terminal.ts").Enhancement>();
  const stopped = deferred<void>();
  const dependencies = {
    ...fixture.dependencies,
    enhancements: {
      "custom-agent": {
        contractVersion: 2 as const,
        async createEnhancement() {
          entered.resolve();
          return factory.promise;
        },
      },
    },
  };
  const running = executeCli(implementationCommand, dependencies);
  await entered.promise;
  fixture.controller.abort();
  assert.equal((await running).summary.outcome, "cancelled");
  assert.equal(fixture.state.tabOptions[0]!.signal?.aborted, true);
  factory.resolve({
    async startMonitoring() {
      assert.fail("late monitoring");
    },
    async waitUntilReady() {
      assert.fail("late readiness");
    },
    onAssignment() {
      assert.fail("late Assignment");
    },
    async stop() {
      stopped.resolve();
    },
  });
  await stopped.promise;
  assert.equal(fixture.state.submissions.length, 0);
  assert.equal(fixture.state.closedTabs.length, 0);
});

for (const phase of ["monitoring", "readiness"] as const) {
  await test(`cancellation during enhancement ${phase} revokes I/O before cleanup and retains the Agent`, async (t) => {
    const fixture = await implementationRun(t);
    const entered = deferred<void>();
    const pending = deferred<void>();
    let stops = 0;
    let commands = 0;
    fixture.dependencies.terminalPlugin.execute = async () => {
      commands++;
    };
    const dependencies = {
      ...fixture.dependencies,
      enhancements: {
        "custom-agent": {
          contractVersion: 2 as const,
          async createEnhancement() {
            return {
              async startMonitoring() {
                if (phase === "monitoring") {
                  entered.resolve();
                  await pending.promise;
                }
              },
              async waitUntilReady() {
                entered.resolve();
                await pending.promise;
                return "native";
              },
              onAssignment() {
                assert.fail("cancelled Assignment");
              },
              async stop() {
                assert.equal(
                  fixture.state.tabOptions[0]!.signal?.aborted,
                  true,
                );
                stops++;
              },
            };
          },
        },
      },
    };
    const running = executeCli(implementationCommand, dependencies);
    await entered.promise;
    fixture.controller.abort();
    assert.equal((await running).summary.outcome, "cancelled");
    pending.resolve();
    assert.equal(stops, 1);
    assert.equal(commands, phase === "monitoring" ? 0 : 1);
    assert.equal(fixture.state.taskCount, 0);
    assert.equal(fixture.state.closedTabs.length, 0);
  });
}

for (const failure of ["factory", "cleanup"] as const) {
  await test(`late enhancement ${failure} failure is reported after cancelled startup`, async (t) => {
    const fixture = await implementationRun(t);
    const entered = deferred<void>();
    const pending = deferred<import("../../src/terminal.ts").Enhancement>();
    const reported = deferred<void>();
    const write = fixture.dependencies.operator.write.bind(
      fixture.dependencies.operator,
    );
    fixture.dependencies.operator.write = (message) => {
      write(message);
      if (message.includes(`late ${failure} failure`)) reported.resolve();
    };
    const dependencies = {
      ...fixture.dependencies,
      enhancements: {
        "custom-agent": {
          contractVersion: 2 as const,
          async createEnhancement() {
            entered.resolve();
            return pending.promise;
          },
        },
      },
    };
    const running = executeCli(implementationCommand, dependencies);
    await entered.promise;
    fixture.controller.abort();
    assert.equal((await running).summary.outcome, "cancelled");
    if (failure === "factory")
      pending.reject(new Error("late factory failure"));
    else
      pending.resolve({
        async startMonitoring() {
          assert.fail("late monitoring");
        },
        async waitUntilReady() {
          assert.fail("late readiness");
        },
        onAssignment() {
          assert.fail("late Assignment");
        },
        async stop() {
          throw new Error("late cleanup failure");
        },
      });
    await reported.promise;
    assert.equal(fixture.state.submissions.length, 0);
    assert.equal(fixture.state.closedTabs.length, 0);
  });
}
