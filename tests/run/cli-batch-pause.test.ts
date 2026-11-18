import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import test from "node:test";
import { validConfig } from "../support/cli-project.ts";
import {
  deferred,
  implementationProgress,
} from "../support/implementation-run.ts";
import { child, parentRun } from "../support/parent-run.ts";

await test(
  "unsupported Run-level skip keeps subsequent sibling operations gated until cancellation",
  { timeout: 10_000 },
  async (t) => {
    const fixture = await parentRun(t, [child(51), child(52)], {
      ...validConfig,
      operationRetry: 0,
    });
    const siblingHeld = deferred<void>();
    const releaseSibling = deferred<void>();
    const firstPause = deferred<void>();
    const secondPause = deferred<void>();
    const firstAnswer = deferred<string>();
    const secondAnswer = deferred<string>();
    const readStart = fixture.dependencies.tracker.readStart.bind(
      fixture.dependencies.tracker,
    );
    const siblingReadFinished = deferred<void>();
    fixture.dependencies.tracker.readStart = async (...args) => {
      const result = await readStart(...args);
      if (args[1] === 52) {
        siblingHeld.resolve();
        await releaseSibling.promise;
        siblingReadFinished.resolve();
      }
      return result;
    };
    fixture.dependencies.gitWorkspace.fetchTargetBranch = async () => {
      await siblingHeld.promise;
      throw new Error("shared Target Branch unavailable");
    };
    let pauses = 0;
    fixture.dependencies.operator.pause = (message) => {
      assert.match(message, /shared Target Branch unavailable/);
      assert.doesNotMatch(message, /s to skip/);
      if (++pauses === 1) {
        firstPause.resolve();
        return firstAnswer.promise;
      }
      secondPause.resolve();
      return secondAnswer.promise;
    };
    const running = fixture.run();
    try {
      await firstPause.promise;
      firstAnswer.resolve("s");
      await secondPause.promise;
      releaseSibling.resolve();
      await siblingReadFinished.promise;
      await new Promise<void>((resolve) => setImmediate(resolve));
      assert.equal(fixture.writes.includes("label:52"), false);
      assert.equal(fixture.writes.includes("assignee:52"), false);
      assert.deepEqual(fixture.dispatched, []);
    } finally {
      releaseSibling.resolve();
      firstAnswer.resolve("q");
      secondAnswer.resolve("q");
      await running;
    }
    assert.equal((await running).summary.outcome, "cancelled");
    assert.equal(fixture.writes.includes("label:52"), false);
    assert.equal(fixture.writes.includes("assignee:52"), false);
    assert.equal(pauses, 2);
  },
);

await test("a Reservation waiting at the pause gate proceeds after retry", async (t) => {
  const fixture = await parentRun(t, [child(51), child(52)], {
    ...validConfig,
    operationRetry: 0,
  });
  const held = deferred<void>();
  const release = deferred<void>();
  const returned = deferred<void>();
  const paused = deferred<void>();
  const answer = deferred<string>();
  const readStart = fixture.dependencies.tracker.readStart.bind(
    fixture.dependencies.tracker,
  );
  fixture.dependencies.tracker.readStart = async (...args) => {
    const result = await readStart(...args);
    if (args[1] === 52) {
      held.resolve();
      await release.promise;
      returned.resolve();
    }
    return result;
  };
  let attempts = 0;
  fixture.dependencies.gitWorkspace.fetchTargetBranch = async () => {
    await held.promise;
    if (++attempts === 1) throw new Error("shared Target Branch unavailable");
    return "a".repeat(40);
  };
  fixture.dependencies.operator.pause = async (message) => {
    if (!message.includes("shared Target Branch unavailable")) return "s";
    paused.resolve();
    return answer.promise;
  };
  const running = fixture.run();
  try {
    await paused.promise;
    release.resolve();
    await returned.promise;
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.equal(fixture.writes.includes("label:52"), false);
    assert.equal(fixture.writes.includes("assignee:52"), false);
  } finally {
    release.resolve();
    answer.resolve("");
  }
  await running;
  assert.equal(
    fixture.writes.filter((write) => write === "label:52").length,
    1,
  );
  assert.equal(
    fixture.writes.filter((write) => write === "assignee:52").length,
    1,
  );
  assert.ok(fixture.dispatched.includes(52));
});

for (const response of ["", "q"] as const) {
  await test(`a non-Agent pause gates sibling operations and dispatch until ${response === "" ? "retry" : "cancellation"}`, async (t) => {
    const fixture = await parentRun(t, [child(51), child(52)], {
      ...validConfig,
      operationRetry: 0,
    });
    const paused = deferred<void>();
    const siblingObserved = deferred<void>();
    const siblingInspecting = deferred<void>();
    const answer = deferred<string>();
    let waiting = false;
    let failed = false;
    const inspect = fixture.dependencies.gitWorkspace.inspect.bind(
      fixture.dependencies.gitWorkspace,
    );
    fixture.dependencies.gitWorkspace.inspect = async (input) => {
      if (input.worktree.endsWith("ticket-51") && !failed) {
        failed = true;
        await siblingInspecting.promise;
        throw new Error("Git temporarily unavailable");
      }
      if (input.worktree.endsWith("ticket-52")) {
        siblingInspecting.resolve();
        await paused.promise;
        siblingObserved.resolve();
      }
      return inspect(input);
    };
    fixture.dependencies.operator.pause = async (message) => {
      if (message.includes("Integration is not scripted in this fixture"))
        return "s";
      waiting = true;
      paused.resolve();
      const result = await answer.promise;
      waiting = false;
      return result;
    };
    let opens = 0;
    const createTab = fixture.dependencies.terminalPlugin.createTab.bind(
      fixture.dependencies.terminalPlugin,
    );
    fixture.dependencies.terminalPlugin.createTab = async (options) => {
      assert.equal(
        waiting,
        false,
        "a paused Run must not open another Agent tab",
      );
      opens += 1;
      return createTab(options);
    };
    const running = fixture.run();
    try {
      await siblingObserved.promise;
      await new Promise<void>((resolve) => setTimeout(resolve, 100));
      assert.equal(opens, 0);
    } finally {
      answer.resolve(response);
    }
    const result = await running;
    assert.equal(
      result.summary.outcome,
      response === "" ? "incomplete" : "cancelled",
    );
    assert.deepEqual(
      [...fixture.dispatched].sort(),
      response === "" ? [51, 52] : [],
    );
  });

  await test(`a pause gates Probe submission in an already-open sibling tab until ${response === "" ? "retry" : "cancellation"}`, async (t) => {
    const fixture = await parentRun(t, [child(51), child(52)], {
      ...validConfig,
      operationRetry: 0,
    });
    const starting = deferred<void>();
    const paused = deferred<void>();
    const startupFinished = deferred<void>();
    const answer = deferred<string>();
    let failed = false;
    const inspect = fixture.dependencies.gitWorkspace.inspect.bind(
      fixture.dependencies.gitWorkspace,
    );
    fixture.dependencies.gitWorkspace.inspect = async (input) => {
      if (input.worktree.endsWith("ticket-51") && !failed) {
        failed = true;
        await starting.promise;
        throw new Error("Git temporarily unavailable");
      }
      return inspect(input);
    };
    const start = fixture.dependencies.terminalPlugin.execute.bind(
      fixture.dependencies.terminalPlugin,
    );
    fixture.dependencies.terminalPlugin.execute = async (tab, command) => {
      await start(tab, command);
      starting.resolve();
      await paused.promise;
      startupFinished.resolve();
      return undefined;
    };
    fixture.dependencies.operator.pause = async (message) => {
      if (message.includes("Integration is not scripted in this fixture"))
        return "s";
      paused.resolve();
      return answer.promise;
    };
    const submitted: string[] = [];
    const submitText = fixture.dependencies.terminalPlugin.onInput.bind(
      fixture.dependencies.terminalPlugin,
    );
    fixture.dependencies.terminalPlugin.onInput = async (tab, text) => {
      submitted.push(text);
      await submitText(tab, text);
    };
    const running = fixture.run();
    try {
      await startupFinished.promise;
      await new Promise<void>((resolve) => setTimeout(resolve, 100));
      assert.deepEqual(submitted, [validConfig.agents.implement.start]);
    } finally {
      answer.resolve(response);
    }
    const result = await running;
    assert.equal(
      result.summary.outcome,
      response === "" ? "incomplete" : "cancelled",
    );
    assert.deepEqual(
      [...fixture.dispatched].sort(),
      response === "" ? [51, 52] : [],
    );
    if (response === "q")
      assert.deepEqual(submitted, [validConfig.agents.implement.start]);
  });
}

await test("a fatal sibling error interrupts unresolved Operator input and retains both executions", async (t) => {
  const fixture = await parentRun(t, [child(51), child(52)], {
    ...validConfig,
    operationRetry: 0,
  });
  const assigned = deferred<void>();
  const paused = deferred<void>();
  const answer = deferred<string>();
  let pauseSignal: AbortSignal | undefined;
  fixture.dependencies.operator.pause = async (
    _message: string,
    signal?: AbortSignal,
  ) => {
    pauseSignal = signal;
    paused.resolve();
    return answer.promise;
  };
  const inspect = fixture.dependencies.gitWorkspace.inspect.bind(
    fixture.dependencies.gitWorkspace,
  );
  fixture.dependencies.gitWorkspace.inspect = async (input) => {
    if (input.worktree.endsWith("ticket-51")) {
      await assigned.promise;
      throw new Error("Git unavailable");
    }
    return inspect(input);
  };
  const submitText = fixture.dependencies.terminalPlugin.onInput.bind(
    fixture.dependencies.terminalPlugin,
  );
  fixture.dependencies.terminalPlugin.onInput = async (tab, text) => {
    if (text.startsWith("Implementation assignment\n")) {
      assigned.resolve();
      await paused.promise;
      throw new Error("sibling transport failed");
    }
    await submitText(tab, text);
  };
  const running = fixture.run();
  let deadline: ReturnType<typeof setTimeout> | undefined;
  try {
    const result = await Promise.race([
      running,
      new Promise<never>((_resolve, reject) => {
        deadline = setTimeout(
          () =>
            reject(
              new Error(
                "Run still waits for Operator input after sibling failure",
              ),
            ),
          1000,
        );
      }),
    ]);
    assert.equal(result.summary.outcome, "failed");
    assert.match(result.summary.failure!, /sibling transport failed/u);
    assert.equal(pauseSignal?.aborted, true);
    assert.equal(
      (await implementationProgress(fixture.directory, 51)).phase,
      "reserved",
    );
    assert.equal(
      (await implementationProgress(fixture.directory, 52)).phase,
      "implementing",
    );
  } finally {
    clearTimeout(deadline);
    answer.resolve("");
    await running;
  }
});

await test(
  "a sibling failure closes real Operator input even when the outer signal and stdin remain open",
  { timeout: 10_000 },
  async (t) => {
    const childProcess = spawn(
      process.execPath,
      [
        "--input-type=module",
        "--eval",
        `
      import assert from "node:assert/strict";
      import test from "node:test";
      import { TerminalOperator } from ${JSON.stringify(new URL("../../src/adapters/terminal.ts", import.meta.url).href)};
      import { parentRun, child } from ${JSON.stringify(new URL("../support/parent-run.ts", import.meta.url).href)};
      import { validConfig } from ${JSON.stringify(new URL("../support/cli-project.ts", import.meta.url).href)};
      await test("real paused input", async (t) => {
        const fixture = await parentRun(t, [child(51), child(52)], { ...validConfig, operationRetry: 0 });
        let assigned;
        const taskStarted = new Promise((resolve) => { assigned = resolve; });
        let paused;
        const inputStarted = new Promise((resolve) => { paused = resolve; });
        class ObservedOperator extends TerminalOperator {
          pause(message, signal) {
            const result = super.pause(message, signal);
            paused();
            return result;
          }
        }
        fixture.dependencies.operator = new ObservedOperator(fixture.controller.signal);
        const inspect = fixture.dependencies.gitWorkspace.inspect.bind(fixture.dependencies.gitWorkspace);
        fixture.dependencies.gitWorkspace.inspect = async (input) => {
          if (input.worktree.endsWith("ticket-51")) {
            await taskStarted;
            throw new Error("Git unavailable");
          }
          return inspect(input);
        };
        const submit = fixture.dependencies.terminalPlugin.onInput.bind(fixture.dependencies.terminalPlugin);
        fixture.dependencies.terminalPlugin.onInput = async (tab, text) => {
          if (text.startsWith("Implementation assignment\\n")) {
            assigned();
            await inputStarted;
            throw new Error("sibling transport failed");
          }
          return submit(tab, text);
        };
        const result = await fixture.run();
        assert.equal(result.summary.outcome, "failed");
        assert.match(result.summary.failure, /sibling transport failed/);
        assert.equal(fixture.controller.signal.aborted, false);
        console.log("COMPLETED_WITH_OPEN_STDIN");
      });
    `,
      ],
      { signal: t.signal },
    );
    let stdout = "";
    let stderr = "";
    childProcess.stdout.setEncoding("utf8").on("data", (text: string) => {
      stdout += text;
    });
    childProcess.stderr.setEncoding("utf8").on("data", (text: string) => {
      stderr += text;
    });
    const result: unknown[] = await once(childProcess, "close");
    assert.equal(result[0], 0, `${stdout}\n${stderr}`);
    assert.match(stdout, /COMPLETED_WITH_OPEN_STDIN/u);
  },
);
