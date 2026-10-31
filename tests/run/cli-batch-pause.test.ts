import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import type { AuditEvent } from "../../src/audit.ts";
import { validConfig } from "../support/cli-project.ts";
import {
  deferred,
  implementationProgress,
} from "../support/implementation-run.ts";
import { child, parentRun } from "../support/parent-run.ts";

await test(
  "unsupported Run-level skip keeps sibling mutations gated until cancellation",
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
    const siblingMutation = deferred<void>();
    const getTicket = fixture.dependencies.tracker.getTicket.bind(
      fixture.dependencies.tracker,
    );
    let siblingReads = 0;
    fixture.dependencies.tracker.getTicket = async (repository, number) => {
      if (number === 52 && ++siblingReads === 3) {
        siblingHeld.resolve();
        await releaseSibling.promise;
      }
      return getTicket(repository, number);
    };
    fixture.dependencies.gitWorkspace.fetchTargetBranch = async () => {
      await siblingHeld.promise;
      throw new Error("shared Target Branch unavailable");
    };
    const assign = fixture.dependencies.tracker.addAssignee.bind(
      fixture.dependencies.tracker,
    );
    fixture.dependencies.tracker.addAssignee = async (
      repository,
      number,
      account,
    ) => {
      if (number === 52) siblingMutation.resolve();
      await assign(repository, number, account);
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
    let deadline: ReturnType<typeof setTimeout> | undefined;
    try {
      await firstPause.promise;
      releaseSibling.resolve();
      const [name] = await readdir(path.join(fixture.directory, "logs"));
      assert.ok(name);
      const until = Date.now() + 3_000;
      for (;;) {
        const events = (
          await readFile(path.join(fixture.directory, "logs", name), "utf8")
        )
          .split("\n")
          .slice(0, -1)
          .map((line) => JSON.parse(line) as AuditEvent)
          .filter(
            (event) =>
              event.operation === "read_blockers" &&
              event.target === "ticket:52:page:1",
          );
        if (
          events.filter((event) => event.result === "started").length >
          events.filter((event) => event.result === "succeeded").length
        )
          break;
        assert.ok(
          Date.now() < until,
          "sibling blocker observation must reach the paused gate",
        );
        await new Promise<void>((resolve) => setImmediate(resolve));
      }
      firstAnswer.resolve("s");
      await secondPause.promise;
      await Promise.race([
        siblingMutation.promise,
        new Promise<void>((resolve) => {
          deadline = setTimeout(resolve, 100);
        }),
      ]);
      assert.equal(
        fixture.writes.includes("assignee:52"),
        false,
        "unsupported input must not authorize a sibling mutation while the next pause is open",
      );
    } finally {
      clearTimeout(deadline);
      releaseSibling.resolve();
      firstAnswer.resolve("q");
      secondAnswer.resolve("q");
      await running;
    }
    assert.equal((await running).summary.outcome, "cancelled");
    assert.equal(pauses, 2);
  },
);

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
      if (ms === 30_000) return;
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
