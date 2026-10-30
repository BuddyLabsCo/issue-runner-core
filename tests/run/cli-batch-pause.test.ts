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

for (const response of ["", "q"] as const) {
  await test(`a non-Agent pause gates sibling operations and dispatch until ${response === "" ? "retry" : "cancellation"}`, async (t) => {
    const fixture = await parentRun(t, [child(51), child(52)], {
      ...validConfig,
      operationRetry: 0,
    });
    const paused = deferred<void>();
    const siblingObserved = deferred<void>();
    const answer = deferred<string>();
    let waiting = false;
    let failed = false;
    const inspect = fixture.dependencies.gitWorkspace.inspect.bind(
      fixture.dependencies.gitWorkspace,
    );
    fixture.dependencies.gitWorkspace.inspect = async (input) => {
      if (input.worktree.endsWith("ticket-51") && !failed) {
        failed = true;
        throw new Error("Git temporarily unavailable");
      }
      if (input.worktree.endsWith("ticket-52")) {
        await paused.promise;
        siblingObserved.resolve();
      }
      return inspect(input);
    };
    fixture.dependencies.operator.pause = async () => {
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
    fixture.dependencies.clock.sleep = async (ms) => {
      assert.equal(ms, 10_000);
      starting.resolve();
      await paused.promise;
      startupFinished.resolve();
    };
    fixture.dependencies.operator.pause = async () => {
      paused.resolve();
      return answer.promise;
    };
    const submitted: string[] = [];
    const submitText = fixture.dependencies.terminalPlugin.submitText.bind(
      fixture.dependencies.terminalPlugin,
    );
    fixture.dependencies.terminalPlugin.submitText = async (tab, text) => {
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
  const submitText = fixture.dependencies.terminalPlugin.submitText.bind(
    fixture.dependencies.terminalPlugin,
  );
  fixture.dependencies.terminalPlugin.submitText = async (tab, text) => {
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
    assert.match(
      result.summary.reasons.join("; "),
      /sibling transport failed/u,
    );
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
        const submit = fixture.dependencies.terminalPlugin.submitText.bind(fixture.dependencies.terminalPlugin);
        fixture.dependencies.terminalPlugin.submitText = async (tab, text) => {
          if (text.startsWith("Implementation assignment\\n")) {
            assigned();
            await inputStarted;
            throw new Error("sibling transport failed");
          }
          return submit(tab, text);
        };
        const result = await fixture.run();
        assert.equal(result.summary.outcome, "failed");
        assert.match(result.summary.reasons.join("; "), /sibling transport failed/);
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
