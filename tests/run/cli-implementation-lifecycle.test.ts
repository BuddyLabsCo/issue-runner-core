/* eslint-disable @typescript-eslint/require-await -- Scripted external boundaries. */
import assert from "node:assert/strict";
import { writeFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import type { TerminalPlugin } from "../../src/terminal.ts";
import { executeCli } from "../../src/cli.ts";
import {
  implementationCommand,
  implementationRun,
} from "../support/implementation-run.ts";
import { validConfig } from "../support/cli-project.ts";

await test("configured commands and prompts use canonical LF while preserving literal Unicode and quotes", async (t) => {
  const fixture = await implementationRun(t, {
    ...validConfig,
    agents: {
      ...validConfig.agents,
      implement: {
        ...validConfig.agents.implement,
        start: 'arbitrary-cli "\u4f60\u597d" "$&" \r\n  --literal \'abc\'\r',
      },
    },
  });
  await writeFile(
    path.join(fixture.directory, "prompts", "implement.md"),
    "Line one\r\n  \u4f60\u597d $& '$`'\r\n\nLast line",
  );
  assert.equal((await fixture.run()).summary.outcome, "incomplete");
  assert.equal(
    fixture.state.submissions[0]?.text,
    'arbitrary-cli "\u4f60\u597d" "$&" \n  --literal \'abc\'\n',
  );
  assert.ok(
    fixture.state.submissions.every(
      (submission) => !submission.text.includes("\r"),
    ),
  );
  assert.match(
    fixture.state.submissions[2]!.text,
    /Line one\n {2}\u4f60\u597d \$& '\$`'\n\nLast line/,
  );
});

await test("independent handles can complete while another handle's command transport is pending", async (t) => {
  const first = await implementationRun(t);
  const second = await implementationRun(t);
  const routes = new Map<object, TerminalPlugin>();
  let release!: () => void;
  let entered!: () => void;
  const pending = new Promise<void>((resolve) => {
    release = resolve;
  });
  const started = new Promise<void>((resolve) => {
    entered = resolve;
  });
  let held = false;
  const plugin: TerminalPlugin = {
    async createTab(options) {
      const target = options.cwd.startsWith(first.directory)
        ? first.dependencies.terminalPlugin
        : second.dependencies.terminalPlugin;
      const tab = await target.createTab(options);
      routes.set(tab, target);
      return tab;
    },
    async submitText(tab, text, chord) {
      const target = routes.get(tab)!;
      if (target === first.dependencies.terminalPlugin && !held) {
        held = true;
        entered();
        await pending;
      }
      await target.submitText(tab, text, chord);
    },
    async closeTab(tab) {
      await routes.get(tab)!.closeTab(tab);
    },
  };
  const firstRun = executeCli(implementationCommand, {
    ...first.dependencies,
    terminalPlugin: plugin,
  });
  await started;
  assert.equal(
    (
      await executeCli(implementationCommand, {
        ...second.dependencies,
        terminalPlugin: plugin,
      })
    ).summary.outcome,
    "incomplete",
  );
  assert.equal(first.state.probeCount, 0);
  release();
  assert.equal((await firstRun).summary.outcome, "incomplete");
  assert.notEqual(first.state.gitConfigs[0], second.state.gitConfigs[0]);
});

await test("a transient close failure retries the same owned handle after the operation delay", async (t) => {
  const fixture = await implementationRun(t);
  let attempts = 0;
  fixture.state.onClose = async () => {
    if (++attempts === 1) throw new Error("owned tab close rejected");
  };
  const result = await fixture.run();
  assert.equal(result.summary.outcome, "incomplete", JSON.stringify(result));
  assert.equal(attempts, 2);
  assert.equal(fixture.state.closedTabs[0], fixture.state.closedTabs[1]);
  assert.deepEqual(
    fixture.state.sleeps.filter((ms) => ms !== 30_000),
    [10_000, 1_000],
  );
  assert.equal(fixture.state.taskCount, 1);
  assert.equal((await fixture.snapshot()).phase, "implementation_completed");
});

await test("operator-authorized close retry never repeats the accepted implementation", async (t) => {
  const fixture = await implementationRun(t);
  let attempts = 0;
  fixture.state.onClose = async () => {
    if (++attempts <= 2) throw new Error("owned tab close rejected");
  };
  fixture.dependencies.operator.pause = async (message) => {
    assert.match(message, /Operation failed: owned tab close rejected/);
    fixture.dependencies.pauses.push(message);
    return "";
  };
  assert.equal((await fixture.run()).summary.outcome, "incomplete");
  assert.equal(attempts, 3);
  assert.equal(fixture.dependencies.pauses.length, 1);
  assert.ok(
    fixture.state.closedTabs.every(
      (tab) => tab === fixture.state.closedTabs[0],
    ),
  );
  assert.equal(fixture.state.probeCount, 1);
  assert.equal(fixture.state.taskCount, 1);
});

for (const selection of [
  "not_ready",
  "foreign_owner",
  "partial",
  "unrecorded",
  "blocked",
] as const) {
  await test(`standalone selection prevents dispatch for ${selection}`, async (t) => {
    const fixture = await implementationRun(t);
    if (selection === "not_ready") fixture.state.ticket.labels = [];
    if (selection === "foreign_owner")
      fixture.state.ticket.assignees = ["another-runner"];
    if (selection === "partial" || selection === "unrecorded")
      fixture.state.ticket.labels!.push("sandcastle:reserved");
    if (selection === "unrecorded") fixture.state.ticket.assignees = ["runner"];
    if (selection === "blocked") {
      fixture.dependencies.tracker.listBlockersPage = async (
        _repo?: string,
        _number?: number,
        page?: number,
      ) =>
        page === 1
          ? { blockers: [], nextPage: 2 }
          : {
              blockers: [{ number: 10, state: "open", stateReason: null }],
              nextPage: null,
            };
    }
    assert.equal((await fixture.run()).summary.outcome, "incomplete");
    assert.deepEqual(fixture.state.events, []);
  });
}
