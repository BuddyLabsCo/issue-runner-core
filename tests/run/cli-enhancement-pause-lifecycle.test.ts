/* eslint-disable @typescript-eslint/require-await -- Controlled external boundaries. */
import assert from "node:assert/strict";
import test from "node:test";
import { enhancementContractVersion } from "../../src/terminal.ts";
import { deferred, publish, committed } from "../support/implementation-run.ts";
import { child, parentDeliveryRun } from "../support/parent-run.ts";
import { enhancedImplementation } from "../support/enhancement-pause.ts";
import { validConfig } from "../support/cli-project.ts";

await test("a new Run restores native continuation without restoring Enhancement Pause or its acknowledgment", async (t) => {
  const fixture = await enhancedImplementation(t);
  const displayed = deferred<void>();
  const lateAnswer = deferred<string>();
  let prompts = 0;
  fixture.dependencies.operator.pause = async () => {
    prompts++;
    displayed.resolve();
    return lateAnswer.promise;
  };
  fixture.control.onAssignment = (id) =>
    fixture.control.context!.enhancementPause(
      id,
      "Pending before interruption",
    );
  fixture.state.onTask = async () => {
    return;
  };
  fixture.state.onSleep = async (ms) => {
    if (ms === 250) {
      await displayed.promise;
      fixture.controller.abort();
    }
  };
  assert.equal((await fixture.run()).summary.outcome, "cancelled");
  const saved = await fixture.snapshot();
  const oldContext = fixture.control.context!;
  const oldId = fixture.control.assignments[0]!.id;
  fixture.dependencies.signal = new AbortController().signal;
  fixture.control.onAssignment = () =>
    oldContext.enhancementPause(oldId, "Stale previous Run request");
  fixture.state.onSleep = async () => {
    return;
  };
  const commands: string[] = [];
  fixture.dependencies.terminalPlugin.execute = async (_tab, command) => {
    commands.push(command);
  };
  fixture.dependencies.terminalPlugin.onInput = async (_tab, text) => {
    assert.equal(text, "continue");
    fixture.state.evidence.commits = committed().commits;
    await publish(saved.invocation!.path, committed());
  };
  assert.equal((await fixture.run()).summary.outcome, "incomplete");
  const restored = await fixture.snapshot();
  assert.equal(restored.execution_id, saved.execution_id);
  assert.equal(restored.input_hash, saved.input_hash);
  assert.equal(restored.invocation!.path, saved.invocation!.path);
  assert.deepEqual(fixture.control.monitored, [undefined, "enhanced-native"]);
  assert.deepEqual(commands, [
    validConfig.agents.implement.resume.replaceAll(
      "{sessionref}",
      "enhanced-native",
    ),
  ]);
  assert.notEqual(fixture.control.assignments[1]!.id, oldId);
  lateAnswer.resolve("");
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(prompts, 1);
  assert.deepEqual(fixture.control.resumed, []);
});

for (const lifecycle of [
  "completed",
  "replaced",
  "cancelled",
  "input failed",
] as const) {
  await test(`an active Enhancement Pause is invalidated when its Assignment is ${lifecycle}`, async (t) => {
    const fixture = await enhancedImplementation(t);
    const displayed = deferred<void>();
    const lateAnswer = deferred<string>();
    let inputSignal: AbortSignal | undefined;
    fixture.control.onAssignment = (id) => {
      if (fixture.control.assignments.length === 1)
        fixture.control.context!.enhancementPause(id, "Human action");
      else
        fixture.control.context!.enhancementPause(
          fixture.control.assignments[0]!.id,
          "Stale replacement request",
        );
    };
    fixture.dependencies.operator.pause = (
      message: string,
      signal?: AbortSignal,
    ) => {
      assert.match(message, /Human action/);
      inputSignal = signal;
      displayed.resolve();
      return lateAnswer.promise;
    };
    const task = fixture.state.onTask;
    fixture.state.onTask = async (file) => {
      await displayed.promise;
      if (lifecycle === "cancelled")
        fixture.controller.abort(new Error("Run cancelled"));
      else if (lifecycle === "input failed")
        throw new Error("transport failed");
      else if (lifecycle === "replaced") await publish(file, {});
      else await task(file);
    };
    if (lifecycle === "replaced") fixture.state.onCorrection = task;
    const result = await fixture.run();
    assert.equal(
      result.summary.outcome,
      lifecycle === "cancelled"
        ? "cancelled"
        : lifecycle === "input failed"
          ? "failed"
          : "incomplete",
    );
    assert.equal(inputSignal?.aborted, true);
    lateAnswer.resolve("");
    await new Promise<void>((resolve) => setImmediate(resolve));
    fixture.control.context!.enhancementPause(
      fixture.control.assignments[0]!.id,
      "Stale closed request",
    );
    assert.deepEqual(fixture.control.resumed, []);
    const output = fixture.dependencies.messages.join("\n");
    assert.match(output, /\[Enhancement Pause ended\] issue-50 implement:/);
    assert.match(
      output,
      lifecycle === "completed"
        ? /Assignment completed/
        : lifecycle === "replaced"
          ? /Assignment replaced/
          : lifecycle === "cancelled"
            ? /Run cancelled/
            : /Terminal input failed/,
    );
    if (lifecycle === "replaced")
      assert.equal(fixture.control.assignments.length, 2);
  });
}

await test(
  "queued handoff completion removes its confirmation and active completion advances without Enter",
  { timeout: 10_000 },
  async (t) => {
    const fixture = await parentDeliveryRun(t, [
      child(51),
      child(52),
      child(53),
    ]);
    const firstDisplayed = deferred<void>();
    const secondQueued = deferred<void>();
    const thirdQueued = deferred<void>();
    const secondClosed = deferred<void>();
    const releaseFirst = deferred<void>();
    const thirdResumed = deferred<void>();
    const thirdDisplayed = deferred<void>();
    const lateAnswer = deferred<string>();
    const lastAnswer = deferred<string>();
    const resumed: number[] = [];
    const prompts: string[] = [];
    const signals: AbortSignal[] = [];
    fixture.dependencies.operator.pause = (
      message: string,
      signal?: AbortSignal,
    ) => {
      assert.ok(signal);
      signals.push(signal);
      prompts.push(message);
      if (prompts.length === 1) {
        firstDisplayed.resolve();
        return lateAnswer.promise;
      }
      assert.equal(prompts.length, 2);
      thirdDisplayed.resolve();
      return lastAnswer.promise;
    };
    fixture.dependencies.enhancements["custom-agent"] = {
      contractVersion: enhancementContractVersion,
      async createEnhancement(_io, _recover, context) {
        const number = Number(/ticket-(\d+)$/u.exec(context.cwd)![1]);
        return {
          async startMonitoring() {
            return;
          },
          async waitUntilReady() {
            return `native-${number}`;
          },
          onAssignment({ id }) {
            if (number === 51) context.enhancementPause(id, "First");
            else
              void (number === 52 ? firstDisplayed : secondQueued).promise.then(
                () => {
                  context.enhancementPause(
                    id,
                    number === 52 ? "Never displayed" : "Third",
                  );
                  (number === 52 ? secondQueued : thirdQueued).resolve();
                },
              );
          },
          async enhancementResume() {
            resumed.push(number);
            thirdResumed.resolve();
          },
          async stop() {
            return;
          },
        };
      },
    };
    const numbers = new Map<object, number>();
    const create = fixture.dependencies.terminalPlugin.createTab.bind(
      fixture.dependencies.terminalPlugin,
    );
    fixture.dependencies.terminalPlugin.createTab = async (options) => {
      const tab = await create(options);
      numbers.set(tab.handle, Number(/ticket-(\d+)$/u.exec(options.cwd)![1]));
      return tab;
    };
    const submit = fixture.dependencies.terminalPlugin.onInput.bind(
      fixture.dependencies.terminalPlugin,
    );
    fixture.dependencies.terminalPlugin.onInput = async (tab, text) => {
      if (text.startsWith("Implementation assignment\n")) {
        const number = numbers.get(tab)!;
        await (
          number === 51
            ? releaseFirst
            : number === 52
              ? thirdQueued
              : thirdResumed
        ).promise;
      }
      await submit(tab, text);
    };
    fixture.dependencies.terminalPlugin.closeTab = async (tab) => {
      if (numbers.get(tab) === 52) secondClosed.resolve();
    };
    const running = fixture.run();
    try {
      await secondClosed.promise;
      assert.equal(prompts.length, 1);
      assert.equal(signals[0]!.aborted, false);
      releaseFirst.resolve();
      await thirdDisplayed.promise;
      assert.match(prompts[1]!, /issue-53 implement.*Third/su);
      assert.equal(signals[0]!.aborted, true);
      lateAnswer.resolve("");
      assert.deepEqual(resumed, []);
      lastAnswer.resolve("");
      assert.equal((await running).summary.outcome, "succeeded");
      assert.deepEqual(resumed, [53]);
      assert.equal(
        fixture.dependencies.messages.filter((message) =>
          message.startsWith("[Enhancement Pause ended]"),
        ).length,
        1,
      );
    } finally {
      fixture.controller.abort();
      releaseFirst.resolve();
      thirdQueued.resolve();
      thirdResumed.resolve();
      lateAnswer.resolve("");
      lastAnswer.resolve("");
      await running;
    }
  },
);
