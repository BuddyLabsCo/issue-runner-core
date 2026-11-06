/* eslint-disable @typescript-eslint/require-await -- Scripted external boundaries. */
import { terminalModule } from "../support/cli-dependencies.ts";
import assert from "node:assert/strict";
import { access, appendFile, rm } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { executeCli } from "../../src/cli.ts";
import {
  committed,
  implementationCommand,
  implementationRun,
  publish,
} from "../support/implementation-run.ts";
import { validConfig } from "../support/cli-project.ts";
import { assertBusinessAssignment } from "../support/prompt-assignment.ts";

await test("missing original Worktree offers only restart or exit before creating replacement work", async (t) => {
  const fixture = await implementationRun(t);
  fixture.state.onTask = async () => {
    fixture.controller.abort();
  };
  assert.equal((await fixture.run()).summary.outcome, "cancelled");
  const saved = await fixture.snapshot();
  await rm(saved.worktree, { recursive: true });
  const before = fixture.state.submissions.length;
  const worktrees = fixture.state.events.filter(
    (event) => event === "worktree",
  ).length;
  const responses = ["s", "retry", "q"];
  const prompts: string[] = [];
  fixture.dependencies.operator.pause = async (message) => {
    prompts.push(message);
    return responses.shift()!;
  };
  const result = await executeCli(implementationCommand, {
    ...fixture.dependencies,
    signal: new AbortController().signal,
    terminal: terminalModule({
      ...fixture.dependencies.terminalPlugin,
      async createTab() {
        assert.fail("missing original context must not open a Runner Tab");
      },
    }),
  });
  assert.equal(result.summary.outcome, "cancelled");
  assert.equal(prompts.length, 3);
  assert.ok(
    prompts.every(
      (message) =>
        message ===
        "Enter to restart the entire Issue #50, or q to exit Runner.",
    ),
  );
  assert.ok(fixture.dependencies.messages.includes("unable to recover"));
  assert.equal(fixture.state.submissions.length, before);
  assert.equal(
    fixture.state.events.filter((event) => event === "worktree").length,
    worktrees,
  );
  assert.deepEqual(await fixture.snapshot(), saved);
  await assert.rejects(access(saved.worktree));
});

await test("a command version upgrade resumes only the saved role with unchanged configuration and literal session substitution", async (t) => {
  const fixture = await implementationRun(t, {
    ...validConfig,
    agents: {
      ...validConfig.agents,
      implement: {
        ...validConfig.agents.implement,
        resume: 'any-cli --resume "{sessionref}" --same "{sessionref}"',
      },
    },
  });
  await appendFile(
    path.join(fixture.directory, "config.yaml"),
    "\nterminalPlugins: { fake: { enhancement: not-installed } }\n",
  );
  fixture.state.onTask = async () => {
    /* Leave the invocation unfinished. */
  };
  fixture.state.onSleep = async (ms) => {
    if (ms === 250) fixture.controller.abort();
  };
  assert.equal((await fixture.run()).summary.outcome, "cancelled");
  const saved = await fixture.snapshot();
  await access(
    path.join(fixture.directory, "recovery", `${saved.input_hash}-50.json`),
  );
  assert.deepEqual(saved.run_arguments, implementationCommand);
  const controller = new AbortController();
  const before = fixture.state.submissions.length;
  const messages = fixture.dependencies.messages.length;
  const sequence: string[] = [];
  fixture.state.onSleep = async (ms) => {
    if (ms === 250) await publish(saved.invocation!.path, committed());
  };
  fixture.state.evidence.commits = committed().commits;
  const result = await executeCli(implementationCommand, {
    ...fixture.dependencies,
    commandVersion: "3.0.0",
    terminalPackageRoot: "/different/installation",
    terminalCliEntry: "/different/installation/cli.mjs",
    signal: controller.signal,
    terminal: terminalModule({
      ...fixture.dependencies.terminalPlugin,
      async createTab(options) {
        assert.equal(options.cwd, saved.worktree);
        const tab =
          await fixture.dependencies.terminalPlugin.createTab(options);
        assert.ok(
          fixture.state.submissions.every((item) => item.tab !== tab.handle),
        );
        sequence.push("fresh Runner Tab");
        return this.bindTab(tab.handle, options);
      },
      async onInput(tab, text, chord) {
        if (text === "continue") {
          assert.ok(
            fixture.dependencies.messages
              .slice(messages)
              .includes(
                `Issue #50 implement sessionid=${saved.roles.implement!.sessionid} handoff=${saved.invocation!.path}`,
              ),
          );
        }
        sequence.push(text === "continue" ? "continue" : "resume");
        await fixture.dependencies.terminalPlugin.onInput(tab, text, chord);
      },
    }),
  });
  assert.equal(result.summary.outcome, "incomplete");
  const resumed = fixture.state.submissions.slice(before);
  assert.equal(
    resumed[0]?.text,
    'any-cli --resume "native/$&/$`/$\'/session" --same "native/$&/$`/$\'/session"',
  );
  assert.equal(resumed[0]?.chord, "Enter");
  assert.deepEqual(
    resumed.slice(1).map((submission) => submission.text),
    ["continue"],
  );
  assert.equal(resumed[1]?.chord, "Shift+Enter");
  assertBusinessAssignment(resumed[1], saved.invocation!.path);
  assert.deepEqual(sequence, ["fresh Runner Tab", "resume", "continue"]);
  assert.equal(fixture.state.probeCount, 1);
  assert.equal(fixture.state.taskCount, 1);
  const recovered = await fixture.snapshot();
  for (const key of [
    "input_hash",
    "run_id",
    "execution_id",
    "invocation",
    "worktree",
    "branch",
    "base",
    "roles",
    "superseded",
  ] as const)
    assert.deepEqual(recovered[key], saved[key]);
});

await test("missing output resumes the saved correction conversation with continue", async (t) => {
  const fixture = await implementationRun(t);
  fixture.state.onTask = async (file) => {
    await publish(file, {});
  };
  fixture.state.onCorrection = async () => {
    fixture.controller.abort();
  };
  assert.equal((await fixture.run()).summary.outcome, "cancelled");
  const saved = await fixture.snapshot();
  assert.equal(saved.pendingPrompt, undefined);
  const before = fixture.state.submissions.length;
  const controller = new AbortController();
  fixture.state.onSleep = async (ms) => {
    if (ms === 250) controller.abort();
  };
  const result = await executeCli(implementationCommand, {
    ...fixture.dependencies,
    signal: controller.signal,
  });
  assert.equal(result.summary.outcome, "cancelled");
  assert.deepEqual(
    fixture.state.submissions
      .slice(before)
      .map(({ text, chord }) => ({ text, chord })),
    [
      { text: 'any-cli --resume "native/$&/$`/$\'/session"', chord: "Enter" },
      { text: "continue", chord: "Shift+Enter" },
    ],
  );
  assert.deepEqual(await fixture.snapshot(), saved);
  const continuation = fixture.state.submissions.at(-1)!;
  assertBusinessAssignment(continuation, saved.invocation!.path);
  assert.equal(continuation.tab, fixture.state.submissions.at(-2)!.tab);
  assert.notEqual(saved.invocation!.path, saved.superseded[0]);
});

await test("cancellation during recovered startup prevents the delayed continue", async (t) => {
  const fixture = await implementationRun(t, {
    ...validConfig,
    agents: {
      ...validConfig.agents,
      implement: { ...validConfig.agents.implement },
    },
  });
  fixture.state.onTask = async () => {
    fixture.controller.abort();
  };
  assert.equal((await fixture.run()).summary.outcome, "cancelled");
  const saved = await fixture.snapshot();
  const controller = new AbortController();
  fixture.dependencies.terminalPlugin.execute = async () => {
    controller.abort();
  };
  const before = fixture.state.submissions.length;
  assert.equal(
    (
      await executeCli(implementationCommand, {
        ...fixture.dependencies,
        signal: controller.signal,
      })
    ).summary.outcome,
    "cancelled",
  );
  assert.deepEqual(
    fixture.state.submissions.slice(before).map(({ text }) => text),
    [],
  );
  assert.deepEqual(await fixture.snapshot(), saved);
  for (const file of fixture.state.gitConfigs)
    await assert.rejects(access(file));
});

await test("invalid retained output resumes only for correction and keeps its implementation assignment", async (t) => {
  const fixture = await implementationRun(t);
  fixture.state.onTask = async () => {
    /* Leave the invocation unfinished. */
  };
  fixture.state.onSleep = async (ms) => {
    if (ms === 250) fixture.controller.abort();
  };
  assert.equal((await fixture.run()).summary.outcome, "cancelled");
  const saved = await fixture.snapshot();
  await publish(saved.invocation!.path, { ...committed(), checks: [] });
  fixture.state.evidence.commits = committed().commits;
  const before = fixture.state.submissions.length;
  assert.equal(
    (
      await executeCli(implementationCommand, {
        ...fixture.dependencies,
        signal: new AbortController().signal,
      })
    ).summary.outcome,
    "incomplete",
  );
  const resumed = fixture.state.submissions.slice(before);
  assert.equal(resumed.length, 2);
  assert.match(resumed[0]!.text, /--resume/);
  assert.match(resumed[1]!.text, /^Correct the implementation handoff:/);
  assert.equal(resumed[1]?.chord, "Shift+Enter");
  const accepted = await fixture.snapshot();
  assert.notEqual(accepted.invocation?.path, saved.invocation?.path);
  assert.deepEqual(accepted.superseded, [saved.invocation!.path]);
  assert.equal(accepted.execution_id, saved.execution_id);
  assert.equal(fixture.state.taskCount, 1);
});

for (const mismatch of [false, true]) {
  await test(`enhanced resume ${mismatch ? "rejects mismatched" : "preserves exact"} native identity`, async (t) => {
    const fixture = await implementationRun(t);
    const native = "  opaque/$&/$`/$'/native  ";
    fixture.state.onProbe = async (assignment) =>
      publish(String(assignment.path), { sessionid: native });
    fixture.state.onTask = async () => fixture.controller.abort();
    await fixture.run();
    const saved = await fixture.snapshot();
    let commands = 0;
    let assignments = 0;
    let recover!: import("../../src/terminal.ts").RequestRecovery;
    let current = "";
    fixture.dependencies.terminalPlugin.execute = async (_tab, command) => {
      assert.equal(command, `any-cli --resume "${native}"`);
      commands++;
      throw new Error("possibly delivered");
    };
    fixture.dependencies.operator.pause = async (message) => {
      if (message.includes("delivery is uncertain")) return "";
      assert.equal(mismatch, true);
      return "q";
    };
    fixture.dependencies.terminalPlugin.onInput = async (_tab, text) => {
      assert.equal(text, "continue");
      fixture.state.evidence.commits = committed().commits;
      await publish(saved.invocation!.path, committed());
    };
    const dependencies = {
      ...fixture.dependencies,
      signal: new AbortController().signal,
      enhancements: {
        "custom-agent": {
          contractVersion: 2 as const,
          async createEnhancement(
            _io: import("../../src/terminal.ts").TerminalIO,
            callback: import("../../src/terminal.ts").RequestRecovery,
          ) {
            recover = callback;
            return {
              async startMonitoring(ref?: string) {
                assert.equal(ref, native);
              },
              async waitUntilReady() {
                return mismatch ? "another-native" : native;
              },
              onAssignment(a: { id: string; expectedFile: string }) {
                assignments++;
                current = a.id;
                assert.equal(a.expectedFile, saved.invocation!.path);
              },
              async stop() {
                await recover(current);
              },
            };
          },
        },
      },
    };
    const result = await executeCli(implementationCommand, dependencies);
    assert.equal(commands, 1);
    assert.equal(assignments, mismatch ? 0 : 1);
    assert.equal((await fixture.snapshot()).roles.implement!.sessionid, native);
    if (!mismatch) assert.match(result.summary.tickets![0]!.detail, /CI-ready/);
  });
}
