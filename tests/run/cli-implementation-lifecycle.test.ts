/* eslint-disable @typescript-eslint/require-await -- Scripted external boundaries. */
import { terminalModule } from "../support/cli-dependencies.ts";
import assert from "node:assert/strict";
import { writeFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import type { TestTerminal } from "../support/cli-dependencies.ts";
import { executeCli } from "../../src/cli.ts";
import {
  implementationCommand,
  implementationRun,
} from "../support/implementation-run.ts";
import { validConfig } from "../support/cli-project.ts";
import { assertBusinessAssignment } from "../support/prompt-assignment.ts";

await test("a numbered Issue uses the viewer returned by IssueStart without a viewer-only query", async (t) => {
  const fixture = await implementationRun(t);
  fixture.dependencies.tracker.readViewer = async () =>
    assert.fail("numbered --issue must not request the viewer separately");

  assert.equal((await fixture.run()).summary.outcome, "incomplete");
  assert.equal(fixture.state.taskCount, 1);
});

await test("a missing authenticated viewer fails with a clear error before dispatch", async (t) => {
  const fixture = await implementationRun(t);
  const tracker = fixture.dependencies.tracker;
  const read = tracker.readIssueStart.bind(tracker);
  tracker.readIssueStart = async (...args) => ({
    ...(await read(...args)),
    viewer: null,
  });
  fixture.dependencies.operator.pause = async (message) => {
    fixture.dependencies.pauses.push(message);
    return "q";
  };

  const result = await fixture.run();

  assert.equal(result.summary.outcome, "cancelled");
  assert.match(
    fixture.dependencies.pauses.join("\n"),
    /authenticated as a normal GitHub user/u,
  );
  assert.equal(fixture.state.taskCount, 0);
});

await test("configured commands stay unchanged and prompts use canonical LF while preserving Unicode and quotes", async (t) => {
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
    'arbitrary-cli "\u4f60\u597d" "$&" \r\n  --literal \'abc\'\r',
  );
  assert.ok(
    fixture.state.submissions
      .slice(1)
      .every((submission) => !submission.text.includes("\r")),
  );
  assert.match(
    fixture.state.submissions[2]!.text,
    /Line one\n {2}\u4f60\u597d \$& '\$`'\n\nLast line/,
  );
  const task = fixture.state.submissions[2]!;
  const file = (await fixture.snapshot()).invocation!.path;
  assert.equal(task.tab, fixture.state.closedTabs[0]);
  assert.equal(task.chord, "Shift+Enter");
  assertBusinessAssignment(task, file);
});

await test("independent handles can complete while another handle's command transport is pending", async (t) => {
  const first = await implementationRun(t);
  const second = await implementationRun(t);
  const routes = new Map<object, TestTerminal>();
  let release!: () => void;
  let entered!: () => void;
  const pending = new Promise<void>((resolve) => {
    release = resolve;
  });
  const started = new Promise<void>((resolve) => {
    entered = resolve;
  });
  let held = false;
  const plugin: TestTerminal = {
    ...first.dependencies.terminalPlugin,
    async createTab(options) {
      const target = options.cwd.startsWith(first.directory)
        ? first.dependencies.terminalPlugin
        : second.dependencies.terminalPlugin;
      const tab = await target.createTab(options);
      routes.set(tab.handle, target);
      return tab;
    },
    async execute(tab, command) {
      const target = routes.get(tab)!;
      if (target === first.dependencies.terminalPlugin && !held) {
        held = true;
        entered();
        await pending;
      }
      await target.execute(tab, command);
    },
    async closeTab(tab) {
      await routes.get(tab)!.closeTab(tab);
    },
  };
  const firstRun = executeCli(implementationCommand, {
    ...first.dependencies,
    terminal: terminalModule(plugin),
  });
  await started;
  assert.equal(
    (
      await executeCli(implementationCommand, {
        ...second.dependencies,
        terminal: terminalModule(plugin),
      })
    ).summary.outcome,
    "incomplete",
  );
  assert.equal(first.state.probeCount, 0);
  release();
  assert.equal((await firstRun).summary.outcome, "incomplete");
  assert.ok(first.state.agentEnvironments.length > 0);
  assert.ok(second.state.agentEnvironments.length > 0);
  for (const env of [
    ...first.state.agentEnvironments,
    ...second.state.agentEnvironments,
  ])
    assert.deepEqual(env, {});
  const firstWorktree = first.state.tabOptions[0]?.cwd;
  const secondWorktree = second.state.tabOptions[0]?.cwd;
  assert.ok(firstWorktree);
  assert.ok(secondWorktree);
  assert.notEqual(firstWorktree, secondWorktree);
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
    fixture.state.sleeps.filter((ms) => ms !== 30_000 && ms !== 10_000),
    [1_000],
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

await test("a fresh Run picks up an Issue assigned only to the authenticated viewer without a Reservation label", async (t) => {
  const fixture = await implementationRun(t);
  fixture.state.ticket.assignees = ["runner"];

  await fixture.run();

  assert.equal(fixture.state.taskCount, 1);
  assert.deepEqual(fixture.state.ticket.assignees, ["runner"]);
  assert.ok(fixture.state.ticket.labels!.includes("sandcastle:reserved"));
});

for (const selection of [
  "not_ready",
  "foreign_owner",
  "mixed_owner",
  "partial",
  "unrecorded",
  "blocked",
] as const) {
  await test(`standalone selection prevents dispatch for ${selection}`, async (t) => {
    const fixture = await implementationRun(t);
    if (selection === "not_ready") fixture.state.ticket.labels = [];
    if (selection === "foreign_owner")
      fixture.state.ticket.assignees = ["another-runner"];
    if (selection === "mixed_owner")
      fixture.state.ticket.assignees = ["runner", "another-runner"];
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
