/* eslint-disable @typescript-eslint/require-await -- Scripted external boundaries. */
import assert from "node:assert/strict";
import test from "node:test";
import { NativeConversations } from "../../src/agent/conversation.ts";
import type { AgentConfig } from "../../src/config.ts";
import type { TerminalPlugin } from "../../src/terminal.ts";
import { deferred } from "../support/implementation-run.ts";
import { createCliDependencies } from "../support/cli-dependencies.ts";
import { agent } from "../support/cli-project.ts";

await test("conversation submissions forward the current assignment and recovery text positionally", async () => {
  const calls: Parameters<TerminalPlugin["submitText"]>[] = [];
  const conversations = new NativeConversations(
    {
      ...createCliDependencies(".").terminalPlugin,
      async submitText(...args) {
        calls.push(args);
      },
    },
    {
      now: () => new Date(),
      async sleep(ms) {
        assert.equal(ms, 10_000);
      },
    },
  );
  const tab = await conversations.open(
    {
      cwd: "/worktree",
      env: {},
      label: "Agent",
      agent: agent.agent,
      submitKey: "Shift+Enter",
    },
    agent,
  );
  calls.length = 0;
  await conversations.submit(
    tab,
    "task\r\n  你好 $&",
    "Shift+Enter",
    "/assigned.json",
    "continue unfinished work $&",
  );
  await conversations.submit(tab, "continue");
  assert.deepEqual(calls, [
    [
      tab,
      "task\n  你好 $&",
      "Shift+Enter",
      "/assigned.json",
      "continue unfinished work $&",
    ],
    [tab, "continue", "Enter", undefined, undefined],
  ]);
});

for (const sessionid of [undefined, "saved-session"]) {
  for (const [startupDelaySeconds, expectedDelay] of [
    [undefined, 10_000],
    [20, 20_000],
    [0.5, 500],
  ] as const) {
    await test(`opening ${sessionid === undefined ? "start" : "resume"} waits ${startupDelaySeconds ?? 10} seconds after command acknowledgement`, async () => {
      const command =
        sessionid === undefined
          ? agent.start
          : 'any-cli --resume "saved-session"';
      const events: (string | number)[] = [];
      const acknowledged = deferred<void>();
      const submitted = deferred<void>();
      const waited = deferred<void>();
      const sleeping = deferred<void>();
      const tab = {};
      const plugin: TerminalPlugin = {
        ...createCliDependencies(".").terminalPlugin,
        async createTab() {
          return tab;
        },
        async submitText(_tab, text) {
          events.push(text);
          if (text === command) {
            submitted.resolve();
            await acknowledged.promise;
            events.push("acknowledged");
          }
        },
        async closeTab() {
          assert.fail("opening must not close the Runner Tab");
        },
      };
      const conversations = new NativeConversations(plugin, {
        now: () => new Date(),
        async sleep(ms) {
          events.push(ms);
          sleeping.resolve();
          await waited.promise;
        },
      });
      const profile: AgentConfig = {
        ...agent,
        ...(startupDelaySeconds === undefined ? {} : { startupDelaySeconds }),
      };
      const firstPrompt =
        sessionid === undefined ? "Session Probe" : "continue";
      const opening = conversations
        .open(
          {
            cwd: "/worktree",
            env: {},
            label: "Agent",
            agent: agent.agent,
            submitKey: agent.submitKey ?? "Enter",
          },
          profile,
          sessionid,
        )
        .then((handle) => conversations.submit(handle, firstPrompt));
      await submitted.promise;
      assert.deepEqual(events, [command]);
      acknowledged.resolve();
      await sleeping.promise;
      assert.deepEqual(events, [command, "acknowledged", expectedDelay]);
      waited.resolve();
      await opening;
      await conversations.submit(tab, "next task");
      assert.deepEqual(events, [
        command,
        "acknowledged",
        expectedDelay,
        firstPrompt,
        "next task",
      ]);
    });
  }
  for (const boundary of ["failure", "before wait", "during wait"]) {
    await test(`${boundary} stops ${sessionid === undefined ? "start" : "resume"} before its first prompt`, async () => {
      const controller = new AbortController();
      const failure = new Error("command rejected");
      const events: string[] = [];
      const conversations = new NativeConversations(
        {
          ...createCliDependencies(".").terminalPlugin,
          async createTab() {
            return {};
          },
          async submitText(_tab, text) {
            events.push(text);
            if (boundary === "failure") throw failure;
            if (boundary === "before wait") controller.abort(failure);
          },
          async closeTab() {
            assert.fail("failed opening must retain the Runner Tab");
          },
        },
        {
          now: () => new Date(),
          async sleep(ms) {
            assert.equal(ms, 20_000);
            events.push("wait");
            controller.abort(failure);
          },
        },
        controller.signal,
      );
      const opening = conversations
        .open(
          {
            cwd: "/worktree",
            env: {},
            label: "Agent",
            agent: agent.agent,
            submitKey: agent.submitKey ?? "Enter",
          },
          { ...agent, startupDelaySeconds: 20 },
          sessionid,
        )
        .then((tab) => conversations.submit(tab, "first prompt"));
      await assert.rejects(
        opening,
        boundary === "failure" && sessionid !== undefined
          ? {
              message: "unable to recover: native conversation resume failed",
              cause: failure,
            }
          : failure,
      );
      assert.equal(events.length, boundary === "during wait" ? 2 : 1);
      assert.ok(!events.includes("first prompt"));
    });
  }
}
