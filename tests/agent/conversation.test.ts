/* eslint-disable @typescript-eslint/require-await -- Scripted external boundaries. */
import assert from "node:assert/strict";
import test from "node:test";
import { NativeConversations } from "../../src/agent/conversation.ts";
import type { TerminalPlugin } from "../../src/terminal.ts";
import { agent } from "../support/cli-project.ts";

await test("conversations execute opaque commands and normalize text through tab-bound I/O", async () => {
  const commands: unknown[][] = [];
  const texts: string[] = [];
  const handle = new Proxy(
    {},
    {
      get() {
        throw new Error("opaque handle inspected");
      },
    },
  );
  const plugin: TerminalPlugin = {
    async createTab(options) {
      assert.equal(options.submitKey, "Shift+Enter");
      assert.equal("agent" in options, false);
      return {
        handle,
        io: {
          async read() {
            return "visible screen";
          },
          async sendKeys() {
            assert.fail("unexpected key input");
          },
          async submitText(text) {
            texts.push(text);
          },
        },
      };
    },
    async execute(...args) {
      commands.push(args);
    },
    async closeTab(tab) {
      assert.equal(tab, handle);
    },
  };
  const conversations = new NativeConversations(plugin);
  const tab = await conversations.create({
    cwd: "/worktree",
    env: {},
    label: "Agent",
    submitKey: "Shift+Enter",
  });
  await conversations.start(tab, agent);
  await conversations.start(tab, agent, "  native/$&/$`/$'  ");
  await conversations.submit(tab, "task\r\n  你好 $&");
  await conversations.submit(tab, "continue");
  await conversations.close(tab);
  assert.deepEqual(commands, [
    [handle, agent.start],
    [handle, `any-cli --resume "  native/$&/$\`/$'  "`],
  ]);
  assert.deepEqual(texts, ["task\n  你好 $&", "continue"]);
});

await test("recovery retains Assignment A through adapter-delayed input before same-path Assignment B", async (t) => {
  const { deferred } = await import("../support/implementation-run.ts");
  const entered = deferred<void>();
  const release = deferred<void>();
  const effects: string[] = [];
  const assignments: { id: string; expectedFile: string }[] = [];
  let recover!: import("../../src/terminal.ts").RequestRecovery;
  const conversations = new NativeConversations({
    async createTab() {
      return {
        handle: {},
        io: {
          async read() {
            return "";
          },
          async sendKeys() {
            return;
          },
          async submitText(text) {
            if (text === "recover A") {
              entered.resolve();
              await release.promise;
            }
            effects.push(text);
          },
        },
      };
    },
    async execute() {
      return;
    },
    async closeTab() {
      return;
    },
  });
  const tab = await conversations.create(
    { cwd: "/worktree", env: {}, label: "Agent", submitKey: "Enter" },
    {
      contractVersion: 3,
      async createEnhancement(_io, callback) {
        recover = callback;
        return {
          enhancementResume() {
            return Promise.resolve();
          },
          async startMonitoring() {
            return;
          },
          async waitUntilReady() {
            return "native";
          },
          onAssignment(a) {
            assignments.push(a);
          },
          async stop() {
            return;
          },
        };
      },
    },
  );
  await conversations.submit(tab, "A", {
    expectedFile: "/same.json",
    recoveryText: "recover A",
  });
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const recovering = recover(assignments[0]!.id);
  let recoveryError: unknown;
  void recovering.catch((error: unknown) => {
    recoveryError = error;
  });
  await entered.promise;
  t.mock.timers.tick(120_000);
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(recoveryError, undefined);
  const next = conversations.submit(tab, "B", {
    expectedFile: "/same.json",
    recoveryText: "recover B",
  });
  const superseded = recover(assignments[0]!.id);
  assert.equal(assignments.length, 1);
  release.resolve();
  await Promise.all([recovering, next, superseded]);
  await recover(assignments[0]!.id);
  await recover(assignments[1]!.id);
  assert.notEqual(assignments[0]!.id, assignments[1]!.id);
  assert.deepEqual(effects, ["A", "recover A", "B", "recover B"]);
  await conversations.complete(tab);
  await recover(assignments[1]!.id);
  assert.equal(effects.length, 4);
  await conversations.close(tab);
});

await test("cleanup attempts are shared, retryable and independent of recovery input failures", async () => {
  const { deferred } = await import("../support/implementation-run.ts");
  const cleanup = deferred<void>();
  let stops = 0;
  let closes = 0;
  let signal!: AbortSignal;
  let current = "";
  let recover!: import("../../src/terminal.ts").RequestRecovery;
  const conversations = new NativeConversations({
    async createTab(options) {
      signal = options.signal!;
      return {
        handle: {},
        io: {
          async read() {
            return "";
          },
          async sendKeys() {
            return;
          },
          async submitText(text) {
            if (text === "recover") throw new Error("real input failure");
          },
        },
      };
    },
    async execute() {
      return;
    },
    async closeTab() {
      closes++;
    },
  });
  const tab = await conversations.create(
    { cwd: "/worktree", env: {}, label: "Agent", submitKey: "Enter" },
    {
      contractVersion: 3,
      async createEnhancement(_io, callback) {
        recover = callback;
        return {
          enhancementResume() {
            return Promise.resolve();
          },
          async startMonitoring() {
            return;
          },
          async waitUntilReady() {
            return "native";
          },
          onAssignment(a) {
            current = a.id;
          },
          async stop() {
            if (++stops === 1) return cleanup.promise;
          },
        };
      },
    },
  );
  await conversations.submit(tab, "task", {
    expectedFile: "/task.json",
    recoveryText: "recover",
  });
  await assert.rejects(recover(current), /real input failure/);
  assert.equal(signal.aborted, true);
  const stopping = conversations.stop(tab);
  const concurrent = conversations.stop(tab);
  assert.equal(stopping, concurrent);
  const closing = conversations.close(tab);
  const rejected = Promise.all([
    assert.rejects(stopping, /cleanup failed/),
    assert.rejects(closing, /cleanup failed/),
  ]);
  cleanup.reject(new Error("cleanup failed"));
  await rejected;
  assert.equal(stops, 1);
  assert.equal(closes, 0);
  await recover(current);
  await conversations.close(tab);
  await conversations.close(tab);
  await conversations.stop(tab);
  assert.equal(stops, 2);
  assert.equal(closes, 1);
});

await test("revocation reaches adapter-queued I/O while an already-started text/key sequence settles", async () => {
  const { deferred } = await import("../support/implementation-run.ts");
  const started = deferred<void>();
  const release = deferred<void>();
  const cleanup = deferred<void>();
  const effects: string[] = [];
  let bound!: import("../../src/terminal.ts").TerminalIO;
  let recover!: import("../../src/terminal.ts").RequestRecovery;
  let assigned = "";
  let signal!: AbortSignal;
  const conversations = new NativeConversations({
    async createTab(options) {
      signal = options.signal!;
      let queue = Promise.resolve();
      const input = (text: string) => {
        const next = queue.then(async () => {
          signal.throwIfAborted();
          effects.push(text);
          if (text === "started") {
            started.resolve();
            await release.promise;
          }
          effects.push("Right", options.submitKey);
        });
        queue = next.catch(() => undefined);
        return next;
      };
      return {
        handle: {},
        io: {
          async read() {
            return "screen";
          },
          submitText: input,
          sendKeys: (keys) => input(keys.join("+")),
        },
      };
    },
    async execute() {
      return;
    },
    async closeTab() {
      effects.push("close");
    },
  });
  const tab = await conversations.create(
    { cwd: "/worktree", env: {}, label: "Agent", submitKey: "Shift+Enter" },
    {
      contractVersion: 3,
      async createEnhancement(io, callback) {
        bound = io;
        recover = callback;
        return {
          enhancementResume() {
            return Promise.resolve();
          },
          async startMonitoring() {
            return;
          },
          async waitUntilReady() {
            return "native";
          },
          onAssignment(a) {
            assigned = a.id;
          },
          async stop() {
            assert.equal(signal.aborted, true);
            return cleanup.promise;
          },
        };
      },
    },
  );
  await conversations.submit(tab, "task", {
    expectedFile: "/task.json",
    recoveryText: "recover",
  });
  effects.length = 0;
  const first = bound.submitText("started");
  await started.promise;
  const queued = bound.submitText("queued");
  const keys = bound.sendKeys(["Control+C"]);
  const recovery = recover(assigned);
  await new Promise<void>((resolve) => setImmediate(resolve));
  const rejected = Promise.all([assert.rejects(queued), assert.rejects(keys)]);
  const stopping = conversations.stop(tab);
  await recover(assigned);
  release.resolve();
  await Promise.all([first, rejected, recovery]);
  assert.deepEqual(effects, ["started", "Right", "Shift+Enter"]);
  cleanup.resolve();
  await stopping;
});

await test("one instance's pending cleanup cannot revoke or stall another instance", async () => {
  const { deferred } = await import("../support/implementation-run.ts");
  const cleanup = deferred<void>();
  const signals: AbortSignal[] = [];
  const effects: string[] = [];
  const conversations = new NativeConversations({
    async createTab(options) {
      signals.push(options.signal!);
      return {
        handle: {},
        io: {
          async read() {
            return "";
          },
          async sendKeys() {
            return;
          },
          async submitText(text) {
            effects.push(text);
          },
        },
      };
    },
    async execute() {
      return;
    },
    async closeTab() {
      return;
    },
  });
  let count = 0;
  const module = {
    contractVersion: 3 as const,
    async createEnhancement() {
      const index = count++;
      return {
        enhancementResume() {
          return Promise.resolve();
        },
        async startMonitoring() {
          return;
        },
        async waitUntilReady() {
          return "native";
        },
        onAssignment() {
          return;
        },
        async stop() {
          if (index === 0) await cleanup.promise;
        },
      };
    },
  };
  const first = await conversations.create(
    { cwd: "/one", env: {}, label: "one", submitKey: "Enter" },
    module,
  );
  const second = await conversations.create(
    { cwd: "/two", env: {}, label: "two", submitKey: "Enter" },
    module,
  );
  const stopping = conversations.stop(first);
  assert.equal(signals[0]!.aborted, true);
  assert.equal(signals[1]!.aborted, false);
  await conversations.submit(second, "independent");
  await conversations.close(second);
  assert.deepEqual(effects, ["independent"]);
  cleanup.resolve();
  await stopping;
});

await test("a real backend recovery failure still rejects after cancellation", async () => {
  const { deferred } = await import("../support/implementation-run.ts");
  const entered = deferred<void>();
  const backend = deferred<void>();
  const controller = new AbortController();
  let recover!: import("../../src/terminal.ts").RequestRecovery;
  let current = "";
  const conversations = new NativeConversations(
    {
      async createTab() {
        return {
          handle: {},
          io: {
            async read() {
              return "screen";
            },
            async sendKeys() {
              return;
            },
            async submitText(text) {
              if (text === "recovery") {
                entered.resolve();
                await backend.promise;
              }
            },
          },
        };
      },
      async execute() {
        return;
      },
      async closeTab() {
        assert.fail("cancelled close");
      },
    },
    controller.signal,
  );
  const tab = await conversations.create(
    { cwd: "/worktree", env: {}, label: "Agent", submitKey: "Enter" },
    {
      contractVersion: 3,
      async createEnhancement(_io, callback) {
        recover = callback;
        return {
          enhancementResume() {
            return Promise.resolve();
          },
          async startMonitoring() {
            return;
          },
          async waitUntilReady() {
            return "native";
          },
          onAssignment(a) {
            current = a.id;
          },
          async stop() {
            return;
          },
        };
      },
    },
  );
  await conversations.submit(tab, "task", {
    expectedFile: "/task.json",
    recoveryText: "recovery",
  });
  const recovering = assert.rejects(
    recover(current),
    /backend delivery failed/,
  );
  await entered.promise;
  controller.abort();
  await conversations.stop(tab);
  backend.reject(new Error("backend delivery failed"));
  await recovering;
  await recover(current);
});
