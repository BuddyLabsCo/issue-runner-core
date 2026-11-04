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
