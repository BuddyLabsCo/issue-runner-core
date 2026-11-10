/* eslint-disable @typescript-eslint/require-await -- Controlled external boundaries. */
import assert from "node:assert/strict";
import test from "node:test";
import { enhancementContractVersion } from "../../src/terminal.ts";
import { deferred } from "../support/implementation-run.ts";
import { child, parentDeliveryRun } from "../support/parent-run.ts";
import { enhancedImplementation } from "../support/enhancement-pause.ts";
for (const reentrant of [false, true]) {
  await test(
    `three parallel Issues keep progressing while Enhancement Pauses share one FIFO reader${reentrant ? " with reentrant admission at the tail" : ""}`,
    { timeout: 10_000 },
    async (t) => {
      const fixture = await parentDeliveryRun(t, [
        child(51),
        child(52),
        child(53),
      ]);
      const firstDisplayed = deferred<void>();
      const secondDisplayed = deferred<void>();
      const thirdDisplayed = deferred<void>();
      const thirdAnswer = deferred<string>();
      const siblingCompleted = deferred<void>();
      const firstAnswer = deferred<string>();
      const secondAnswer = deferred<string>();
      const completed = new Map(
        [51, 52].map((number) => [number, deferred<void>()]),
      );
      const resumed: number[] = [];
      const prompts: string[] = [];
      let readers = 0;
      fixture.dependencies.operator.pause = async (message) => {
        assert.equal(
          ++readers,
          1,
          "only the displayed confirmation reads input",
        );
        prompts.push(message);
        try {
          if (prompts.length === 1) {
            firstDisplayed.resolve();
            return await firstAnswer.promise;
          }
          if (prompts.length === 2) {
            secondDisplayed.resolve();
            return await secondAnswer.promise;
          }
          thirdDisplayed.resolve();
          return await thirdAnswer.promise;
        } finally {
          readers--;
        }
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
              if (number === 51) {
                context.enhancementPause(id, "Human action needed");
                context.enhancementPause(id, "Duplicate active message");
              }
              if (number === 52)
                void firstDisplayed.promise.then(() => {
                  context.enhancementPause(id, "Human action needed");
                  context.enhancementPause(id, "Duplicate queued message");
                });
            },
            async enhancementResume(id) {
              assert.ok(id);
              resumed.push(number);
              if (reentrant && number === 51 && resumed.length === 1)
                context.enhancementPause(id, "Second action");
              else completed.get(number)!.resolve();
            },
            async stop() {
              return;
            },
          };
        },
      };
      const submit = fixture.dependencies.terminalPlugin.onInput.bind(
        fixture.dependencies.terminalPlugin,
      );
      const create = fixture.dependencies.terminalPlugin.createTab.bind(
        fixture.dependencies.terminalPlugin,
      );
      const numbers = new Map<object, number>();
      fixture.dependencies.terminalPlugin.createTab = async (options) => {
        const tab = await create(options);
        numbers.set(tab.handle, Number(/ticket-(\d+)$/u.exec(options.cwd)![1]));
        return tab;
      };
      fixture.dependencies.terminalPlugin.onInput = async (tab, text) => {
        if (text.startsWith("Implementation assignment\n"))
          await completed.get(numbers.get(tab)!)?.promise;
        await submit(tab, text);
      };
      fixture.dependencies.terminalPlugin.closeTab = async (tab) => {
        if (numbers.get(tab) === 53) siblingCompleted.resolve();
      };
      const running = fixture.run();
      try {
        await Promise.race([
          firstDisplayed.promise,
          running.then((result) => assert.fail(JSON.stringify(result.summary))),
        ]);
        await siblingCompleted.promise;
        assert.deepEqual(resumed, []);
        firstAnswer.resolve("");
        await secondDisplayed.promise;
        assert.deepEqual(resumed, [51]);
        assert.match(prompts[0]!, /issue-51 implement.*Human action needed/su);
        assert.match(prompts[1]!, /issue-52 implement.*Human action needed/su);
        secondAnswer.resolve("");
        if (reentrant) {
          await thirdDisplayed.promise;
          assert.deepEqual(resumed, [51, 52]);
          assert.match(prompts[2]!, /issue-51 implement.*Second action/su);
          thirdAnswer.resolve("");
        }
        assert.equal((await running).summary.outcome, "succeeded");
        assert.deepEqual(resumed, reentrant ? [51, 52, 51] : [51, 52]);
        assert.equal(prompts.length, reentrant ? 3 : 2);
        assert.equal(readers, 0);
      } finally {
        fixture.controller.abort();
        firstAnswer.resolve("");
        secondAnswer.resolve("");
        thirdAnswer.resolve("");
        for (const completion of completed.values()) completion.resolve();
        await running;
      }
    },
  );
}

await test("only an empty submitted line acknowledges Enhancement Pause, retaining its original prompt", async (t) => {
  const fixture = await enhancedImplementation(t);
  const resumed = deferred<void>();
  const prompts: string[] = [];
  const responses = ["s", "q", " ", ""];
  fixture.control.onAssignment = (id) => {
    fixture.control.context!.enhancementPause("stale", "Ignore stale request");
    fixture.control.context!.enhancementPause(id, "Original message");
    fixture.control.context!.enhancementPause(id, "Ignore duplicate message");
  };
  fixture.control.onResume = async () => {
    resumed.resolve();
  };
  fixture.dependencies.operator.pause = async (message) => {
    assert.deepEqual(fixture.control.resumed, []);
    prompts.push(message);
    assert.ok(
      prompts.length <= responses.length,
      "unsupported input must retain one request",
    );
    return responses[prompts.length - 1]!;
  };
  const task = fixture.state.onTask;
  fixture.state.onTask = async (file) => {
    await resumed.promise;
    await task(file);
  };
  assert.equal((await fixture.run()).summary.outcome, "incomplete");
  assert.equal(prompts.length, 4);
  assert.equal(new Set(prompts).size, 1);
  assert.match(prompts[0]!, /issue-50 implement.*Original message/su);
  assert.deepEqual(fixture.control.resumed, [
    fixture.control.assignments[0]!.id,
  ]);
  assert.equal(
    fixture.dependencies.messages.filter(
      (message) => message === "Unsupported input.",
    ).length,
    3,
  );
});

for (const enhancementFirst of [true, false]) {
  await test(
    `mixed pauses preserve FIFO when ${enhancementFirst ? "Enhancement" : "Operator"} Pause arrives first`,
    { timeout: 10_000 },
    async (t) => {
      const fixture = await enhancedImplementation(t);
      const firstDisplayed = deferred<void>();
      const secondDisplayed = deferred<void>();
      const notified = deferred<void>();
      const answers = [deferred<string>(), deferred<string>()];
      const prompts: string[] = [];
      const request = () =>
        fixture.control.context!.enhancementPause(
          fixture.control.assignments[0]!.id,
          "Mixed enhancement",
        );
      fixture.control.onAssignment = () => {
        if (enhancementFirst) request();
      };
      fixture.control.onResume = async () => {
        notified.resolve();
      };
      fixture.dependencies.operator.pause = async (message) => {
        prompts.push(message);
        assert.ok(prompts.length <= 2);
        if (!enhancementFirst && prompts.length === 1) request();
        (prompts.length === 1 ? firstDisplayed : secondDisplayed).resolve();
        return answers[prompts.length - 1]!.promise;
      };
      const inspect = fixture.dependencies.gitWorkspace.inspect.bind(
        fixture.dependencies.gitWorkspace,
      );
      let failed = false;
      fixture.dependencies.gitWorkspace.inspect = async (input) => {
        if (fixture.state.taskCount > 0) {
          if (!failed) {
            failed = true;
            throw new Error("Mixed operator failure");
          }
          await notified.promise;
        }
        return inspect(input);
      };
      const running = fixture.run();
      try {
        await firstDisplayed.promise;
        if (enhancementFirst) {
          const deadline = Date.now() + 3000;
          while (
            !Object.values((await fixture.snapshot()).operations ?? {}).some(
              (operation) => operation.error === "Mixed operator failure",
            )
          ) {
            assert.ok(
              Date.now() < deadline,
              "Operator Pause must be admitted behind Enhancement Pause",
            );
            // Allow checkpoint replacement between reads on Windows.
            await new Promise<void>((resolve) => setTimeout(resolve, 100));
          }
        }
        assert.equal(
          prompts.length,
          1,
          "a later pause cannot preempt the active reader",
        );
        assert.match(
          prompts[0]!,
          enhancementFirst ? /Mixed enhancement/ : /Mixed operator failure/,
        );
        answers[0]!.resolve("");
        await secondDisplayed.promise;
        assert.match(
          prompts[1]!,
          enhancementFirst ? /Mixed operator failure/ : /Mixed enhancement/,
        );
        answers[1]!.resolve("");
        assert.equal((await running).summary.outcome, "incomplete");
        assert.deepEqual(fixture.control.resumed, [
          fixture.control.assignments[0]!.id,
        ]);
      } finally {
        fixture.controller.abort();
        for (const answer of answers) answer.resolve("");
        notified.resolve();
        await running;
      }
    },
  );
}

for (const failure of [
  "synchronous throw",
  "rejection",
  "never settles",
] as const) {
  await test(`resume ${failure} cannot delay handoff acceptance or cleanup`, async (t) => {
    const fixture = await enhancedImplementation(t);
    const notified = deferred<void>();
    fixture.control.onAssignment = (id) =>
      fixture.control.context!.enhancementPause(id, "Continue");
    fixture.control.onResume = () => {
      notified.resolve();
      if (failure === "synchronous throw") throw new Error("resume failed");
      if (failure === "rejection")
        return Promise.reject(new Error("resume failed"));
      return new Promise(() => {
        /* Deliberately never settles. */
      });
    };
    let prompts = 0;
    fixture.dependencies.operator.pause = async () => {
      prompts++;
      return "";
    };
    const task = fixture.state.onTask;
    fixture.state.onTask = async (file) => {
      await notified.promise;
      await task(file);
    };
    assert.equal((await fixture.run()).summary.outcome, "incomplete");
    assert.deepEqual(fixture.control.resumed, [
      fixture.control.assignments[0]!.id,
    ]);
    assert.equal(prompts, 1);
    assert.equal(fixture.state.closedTabs.length, 1);
  });
}

await test("a reentrant resume request requires another Enter for the same Assignment", async (t) => {
  const fixture = await enhancedImplementation(t);
  const notified = deferred<void>();
  const prompts: string[] = [];
  fixture.control.onAssignment = (id) =>
    fixture.control.context!.enhancementPause(id, "First action");
  fixture.control.onResume = async (id) => {
    if (fixture.control.resumed.length === 1)
      fixture.control.context!.enhancementPause(id, "Second action");
    else notified.resolve();
  };
  fixture.dependencies.operator.pause = async (message) => {
    prompts.push(message);
    assert.equal(fixture.control.resumed.length, prompts.length - 1);
    return "";
  };
  const task = fixture.state.onTask;
  fixture.state.onTask = async (file) => {
    await notified.promise;
    await task(file);
  };
  assert.equal((await fixture.run()).summary.outcome, "incomplete");
  assert.equal(prompts.length, 2);
  assert.match(prompts[0]!, /First action/);
  assert.match(prompts[1]!, /Second action/);
  assert.deepEqual(
    fixture.control.resumed,
    Array(2).fill(fixture.control.assignments[0]!.id),
  );
});

for (const response of [null, "input failure"] as const) {
  await test(`${String(response)} ends only the Enhancement Pause without a callback or retry loop`, async (t) => {
    const fixture = await enhancedImplementation(t);
    const displayed = deferred<void>();
    fixture.control.onAssignment = (id) =>
      fixture.control.context!.enhancementPause(id, "Human action");
    let prompts = 0;
    fixture.dependencies.operator.pause = async () => {
      assert.equal(++prompts, 1);
      displayed.resolve();
      if (response === "input failure") throw new Error(response);
      return response;
    };
    const task = fixture.state.onTask;
    fixture.state.onTask = async (file) => {
      await displayed.promise;
      await task(file);
    };
    assert.equal((await fixture.run()).summary.outcome, "incomplete");
    assert.deepEqual(fixture.control.resumed, []);
    assert.equal(fixture.controller.signal.aborted, false);
    assert.equal(fixture.state.closedTabs.length, 1);
  });
}
