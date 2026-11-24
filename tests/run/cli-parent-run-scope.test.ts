import assert from "node:assert/strict";
import { access, readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { executeCli } from "../../src/cli.ts";
import { validConfig } from "../support/cli-project.ts";
import { implementationProgress } from "../support/implementation-run.ts";
import { child, parentRun } from "../support/parent-run.ts";
import { otherCheckpoint, updateConfig } from "../support/run-scope.ts";

await test("a Parent Run resumes after unrelated configuration and equivalent CLI spelling changes", async (t) => {
  const fixture = await parentRun(t, [child(50)], {
    ...validConfig,
    issueList: [50],
    maxBatchSize: 1,
  });
  const submit = fixture.dependencies.terminalPlugin.onInput.bind(
    fixture.dependencies.terminalPlugin,
  );
  fixture.dependencies.terminalPlugin.onInput = async (tab, text, chord) => {
    if (text.startsWith("Implementation assignment\n")) {
      fixture.controller.abort();
      return;
    }
    await submit(tab, text, chord);
  };
  assert.equal((await fixture.run()).summary.outcome, "cancelled");
  const saved = await implementationProgress(fixture.directory, 50);
  await updateConfig(fixture, (config) => ({
    ...config,
    timeouts: { requiredChecksMinutes: 5, mergeQueueMinutes: 5 },
    maxBatchSize: 2,
  }));
  const controller = new AbortController();
  fixture.dependencies.signal = controller.signal;
  const submissions: string[] = [];
  fixture.dependencies.terminalPlugin.onInput = async (tab, text, chord) => {
    submissions.push(text);
    await submit(tab, text, chord);
    if (text === "continue") controller.abort();
  };

  const result = await executeCli(
    ["run", "--parent=48", "--project", "demo"],
    fixture.dependencies,
  );

  assert.equal(
    result.summary.outcome,
    "cancelled",
    JSON.stringify(result.summary),
  );
  assert.deepEqual(submissions.slice(0, 2), [
    `any-cli --resume "${saved.roles.implement!.sessionid}"`,
    "continue",
  ]);
  assert.equal(
    (await implementationProgress(fixture.directory, 50)).execution_id,
    saved.execution_id,
  );
});

for (const change of ["Parent Ticket", "configured Issue list"] as const) {
  await test(`a changed ${change} starts a new Parent processing scope and retains old resources`, async (t) => {
    const tickets = [child(50)];
    const fixture = await parentRun(t, tickets, {
      ...validConfig,
      issueList: [50],
      maxBatchSize: 1,
    });
    const submit = fixture.dependencies.terminalPlugin.onInput.bind(
      fixture.dependencies.terminalPlugin,
    );
    fixture.dependencies.terminalPlugin.onInput = async (tab, text, chord) => {
      if (text.startsWith("Implementation assignment\n")) {
        fixture.controller.abort();
        return;
      }
      await submit(tab, text, chord);
    };
    assert.equal((await fixture.run()).summary.outcome, "cancelled");
    const saved = await implementationProgress(fixture.directory, 50);
    const oldFile = path.join(
      fixture.directory,
      "recovery",
      `${saved.input_hash}-50.json`,
    );
    const oldText = await readFile(oldFile, "utf8");
    tickets[0]!.labels = ["ready-for-agent"];
    tickets[0]!.assignees = [];
    if (change === "configured Issue list")
      await updateConfig(fixture, (config) => ({
        ...config,
        issueList: [50, 51],
      }));
    const controller = new AbortController();
    fixture.dependencies.signal = controller.signal;
    fixture.dependencies.terminalPlugin.onInput = async (tab, text, chord) => {
      if (text.startsWith("Implementation assignment\n")) {
        controller.abort();
        return;
      }
      await submit(tab, text, chord);
    };
    const result = await executeCli(
      [
        "run",
        "--project",
        "demo",
        "--parent",
        change === "Parent Ticket" ? "49" : "48",
      ],
      fixture.dependencies,
    );

    assert.equal(
      result.summary.outcome,
      "cancelled",
      JSON.stringify(result.summary),
    );
    const current = (await otherCheckpoint(fixture.directory, saved.input_hash))
      .progress;
    assert.notEqual(current.execution_id, saved.execution_id);
    assert.equal(await readFile(oldFile, "utf8"), oldText);
    await access(saved.worktree);
  });
}

await test("changing Parent Review participation starts a new processing scope", async (t) => {
  const tickets = [child(50)];
  const fixture = await parentRun(t, tickets, {
    ...validConfig,
    issueList: [50],
    maxBatchSize: 1,
  });
  const submit = fixture.dependencies.terminalPlugin.onInput.bind(
    fixture.dependencies.terminalPlugin,
  );
  fixture.dependencies.terminalPlugin.onInput = async (tab, text, chord) => {
    if (text.startsWith("Implementation assignment\n")) {
      fixture.controller.abort();
      return;
    }
    await submit(tab, text, chord);
  };
  assert.equal((await fixture.run()).summary.outcome, "cancelled");
  const saved = await implementationProgress(fixture.directory, 50);
  tickets[0]!.labels = ["ready-for-agent"];
  tickets[0]!.assignees = [];
  await updateConfig(fixture, (config) => ({
    ...config,
    workflow: { review: true },
  }));
  const controller = new AbortController();
  fixture.dependencies.signal = controller.signal;
  fixture.dependencies.terminalPlugin.onInput = async (tab, text, chord) => {
    if (text.startsWith("Implementation assignment\n")) {
      controller.abort();
      return;
    }
    await submit(tab, text, chord);
  };

  const result = await fixture.run();

  assert.equal(
    result.summary.outcome,
    "cancelled",
    JSON.stringify(result.summary),
  );
  assert.notEqual(
    (await otherCheckpoint(fixture.directory, saved.input_hash)).progress
      .execution_id,
    saved.execution_id,
  );
});
