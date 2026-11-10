/* eslint-disable @typescript-eslint/require-await -- Controlled external boundaries. */
import assert from "node:assert/strict";
import test from "node:test";
import { NativeConversations } from "../../src/agent/conversation.ts";
import { TerminalConfirmations } from "../../src/run/confirmations.ts";
import {
  enhancementContractVersion,
  type EnhancementContext,
  type EnhancementModule,
} from "../../src/terminal.ts";
import { createTestTerminal } from "../support/cli-dependencies.ts";
import { deferred } from "../support/implementation-run.ts";

for (const event of ["stop", "close", "replace", "cancel Run"] as const) {
  for (const target of ["active", "queued"] as const) {
    await test(`${event} invalidates ${target} Enhancement Pause without resuming stale work`, async () => {
      const run = new AbortController();
      const displayed = deferred<void>();
      const advanced = deferred<void>();
      const answers = [
        deferred<string>(),
        deferred<string>(),
        deferred<string>(),
      ];
      const prompts: string[] = [];
      const messages: string[] = [];
      const resumed: [number, string][] = [];
      const signals: AbortSignal[] = [];
      const confirmations = new TerminalConfirmations(
        {
          write: (message) => messages.push(message),
          pause(message, signal) {
            assert.ok(signal);
            signals.push(signal);
            prompts.push(message);
            (prompts.length === 1 ? displayed : advanced).resolve();
            return answers[prompts.length - 1]!.promise;
          },
        },
        run.signal,
      );
      const conversations = new NativeConversations(
        createTestTerminal(),
        run.signal,
        (message) => messages.push(message),
        undefined,
        confirmations,
      );
      const instances: { context: EnhancementContext; id: string }[] = [];
      const module: EnhancementModule = {
        contractVersion: enhancementContractVersion,
        async createEnhancement(_io, _recover, context) {
          const index = instances.length;
          const instance = { context, id: "" };
          instances.push(instance);
          return {
            async startMonitoring() {
              return;
            },
            async waitUntilReady() {
              return "native";
            },
            onAssignment({ id }) {
              instance.id = id;
            },
            async enhancementResume(id) {
              resumed.push([index, id]);
            },
            async stop() {
              return;
            },
          };
        },
      };
      const tabs = [];
      const assignment = {
        expectedFile: "/same.json",
        recoveryText: "recovery",
      };
      for (let index = 0; index < 3; index++) {
        const tab = await conversations.create(
          {
            cwd: "/worktree",
            env: {},
            label: "same task implement",
            submitKey: "Enter",
          },
          module,
        );
        tabs.push(tab);
        await conversations.submit(tab, "task", assignment);
      }
      // Identical labels and paths cannot grant another instance's capability.
      instances[1]!.context.enhancementPause(
        instances[0]!.id,
        "Wrong instance",
      );
      for (const [index, instance] of instances.entries())
        instance.context.enhancementPause(instance.id, `Request ${index}`);
      await displayed.promise;
      const index = target === "active" ? 0 : 1;
      const staleId = instances[index]!.id;
      if (event === "cancel Run") run.abort(new Error("Run ended"));
      else if (event === "replace")
        await conversations.submit(tabs[index]!, "correction", assignment);
      else await conversations[event](tabs[index]!);
      instances[index]!.context.enhancementPause(
        staleId,
        "Stale lifecycle request",
      );
      if (event !== "cancel Run") {
        if (target === "queued") await conversations.complete(tabs[0]!);
        await advanced.promise;
        assert.match(
          prompts[1]!,
          target === "active" ? /Request 1/ : /Request 2/,
        );
      }
      assert.equal(signals[0]!.aborted, true);
      answers[0]!.resolve("");
      if (event !== "cancel Run") answers[1]!.resolve("");
      await new Promise<void>((resolve) => setImmediate(resolve));
      const survivor = target === "active" ? 1 : 2;
      assert.deepEqual(
        resumed,
        event === "cancel Run" ? [] : [[survivor, instances[survivor]!.id]],
      );
      if (event === "cancel Run") {
        assert.deepEqual(resumed, []);
        assert.equal(prompts.length, 1);
      }
      assert.ok(
        messages.some(
          (message) =>
            message.startsWith(
              "[Enhancement Pause ended] same task implement:",
            ) && /Assignment|Enhancement stopped|Run ended/.test(message),
        ),
      );
      await conversations.stopAll();
    });
  }
}
