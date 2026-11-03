/* eslint-disable @typescript-eslint/require-await -- Scripted external boundaries. */
import assert from "node:assert/strict";
import test from "node:test";
import { NativeConversations } from "../../src/agent/conversation.ts";
import type { TerminalPlugin } from "../../src/terminal.ts";
import { createCliDependencies } from "../support/cli-dependencies.ts";
import { agent } from "../support/cli-project.ts";

await test("conversation submissions forward the current assignment and recovery text positionally", async () => {
  const calls: Parameters<TerminalPlugin["submitText"]>[] = [];
  const conversations = new NativeConversations({
    ...createCliDependencies(".").terminalPlugin,
    async submitText(...args) {
      calls.push(args);
    },
  });
  const tab = await conversations.create({
    cwd: "/worktree",
    env: {},
    label: "Agent",
    agent: agent.agent,
    submitKey: "Shift+Enter",
  });
  await conversations.start(tab, agent);
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
