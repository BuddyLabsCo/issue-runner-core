/* eslint-disable @typescript-eslint/require-await -- Scripted external boundaries. */
import assert from "node:assert/strict";
import { access, readFile, readdir } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { executeCli } from "../../src/cli.ts";
import {
  documentCommand,
  documentationRun,
} from "../support/documentation-run.ts";
import { committed, publish } from "../support/implementation-run.ts";
import { assertBusinessAssignment } from "../support/prompt-assignment.ts";

const noChange = {
  outcome: "no_change",
  pr_title: "docs: maintain documentation",
  pr_body: "Maintain documentation.",
  summary: "Documentation is current",
  commits: [],
  findings_file: null,
};

for (const outcome of ["committed", "no_change"] as const) {
  await test(`documentation recovery preserves its active correction and its own ${outcome} result`, async (t) => {
    const fixture = await documentationRun(t);
    fixture.state.onTask = (file) => publish(file, {});
    fixture.state.onCorrection = async () => {
      /* Wait for the assigned correction. */
    };
    fixture.state.onSleep = async (ms) => {
      if (ms === 250) fixture.controller.abort();
    };
    assert.equal((await fixture.run()).summary.outcome, "cancelled");
    const saved = await fixture.snapshot();
    const initial = fixture.state.submissions.find(({ text }) =>
      text.startsWith("Implementation assignment\n"),
    )!;
    const correction = fixture.state.submissions.at(-1)!;
    assertBusinessAssignment(initial, saved.superseded[0]!, "documentation");
    assertBusinessAssignment(
      correction,
      saved.invocation!.path,
      "documentation",
    );
    assert.equal(initial.tab, correction.tab);
    assert.equal(initial.chord, "Shift+Enter");
    assert.equal(correction.chord, "Shift+Enter");
    assert.notEqual(initial.expectedFile, correction.expectedFile);
    assert.equal(fixture.maintenance.cleanup.length, 0);
    for (const file of saved.superseded) await publish(file, noChange);
    const recovery = path.join(fixture.directory, "recovery");
    // An unrelated business checkpoint must not supply history, counts, or paths.
    await publish(path.join(recovery, `${saved.input_hash}-77.json`), {
      ...saved,
      ticket: 77,
      purpose: undefined,
      execution_id: "business-execution",
      roles: { implement: { sessionid: "business-history" } },
    });
    const submitted = fixture.state.submissions.length;
    const sleeps = fixture.state.sleeps.length;
    const configs = fixture.state.gitConfigs.length;
    const result = outcome === "committed" ? committed() : noChange;
    fixture.state.evidence.changed = outcome === "committed";
    fixture.state.evidence.commits = result.commits;
    fixture.state.onProbe = async () => assert.fail("metadata must stay fixed");
    fixture.state.onCorrection = async () =>
      assert.fail("resume uses continue for already submitted feedback");
    const submit = fixture.dependencies.terminalPlugin.submitText.bind(
      fixture.dependencies.terminalPlugin,
    );
    fixture.dependencies.terminalPlugin.submitText = async (
      tab,
      text,
      chord,
      expectedFile,
      recoveryText,
    ) => {
      await submit(tab, text, chord, expectedFile, recoveryText);
      if (text === "continue") await publish(saved.invocation!.path, result);
    };
    fixture.state.onSleep = async (ms) => assert.ok(ms > 0);
    fixture.dependencies.signal = new AbortController().signal;

    const resumed = await fixture.run();

    assert.equal(resumed.summary.outcome, "succeeded", JSON.stringify(resumed));
    assert.deepEqual(
      fixture.state.submissions.slice(submitted).map(({ text }) => text),
      ['document-cli --resume "native/$&/$`/$\'/session"', "continue"],
    );
    const continuation = fixture.state.submissions.at(-1)!;
    assertBusinessAssignment(
      continuation,
      saved.invocation!.path,
      "documentation",
    );
    assert.equal(continuation.chord, "Shift+Enter");
    assert.equal(continuation.tab, fixture.state.submissions[submitted]!.tab);
    assert.deepEqual(
      fixture.state.sleeps.slice(sleeps).filter((ms) => ms !== 30_000),
      [250],
    );
    const current = await fixture.snapshot();
    assert.equal(current.execution_id, saved.execution_id);
    assert.deepEqual(current.roles, saved.roles);
    assert.deepEqual(current.invocation, saved.invocation);
    assert.equal(current.pr_title, result.pr_title);
    assert.equal(current.pr_body, result.pr_body);
    assert.deepEqual(current.result, result);
    assert.equal(fixture.state.probeCount, 1);
    assert.equal(fixture.state.taskCount, 1);
    assert.equal(fixture.maintenance.creates, 1);
    assert.equal(fixture.state.gitConfigs.length, configs + 1);
    assert.notEqual(
      fixture.state.gitConfigs.at(-1),
      fixture.state.gitConfigs[0],
    );
    for (const file of fixture.state.gitConfigs)
      await assert.rejects(access(file), { code: "ENOENT" });
  });
}

for (const change of ["arguments", "command name", "command rename"]) {
  await test(`a change in documentation ${change} starts new resources without consuming the old checkpoint`, async (t) => {
    const fixture = await documentationRun(t);
    fixture.state.onTask = async () => fixture.controller.abort();
    assert.equal((await fixture.run()).summary.outcome, "cancelled");
    const old = await fixture.snapshot();
    const recovery = path.join(fixture.directory, "recovery");
    const files = await readdir(recovery);
    const saved = await Promise.all(
      files.map((file) => readFile(path.join(recovery, file), "utf8")),
    );
    const controller = new AbortController();
    fixture.dependencies.signal = controller.signal;
    fixture.state.onTask = async () => controller.abort();

    if (change !== "arguments")
      fixture.dependencies.commandName =
        change === "command name"
          ? "another-terminal"
          : "generic-terminal-next";
    const result = await executeCli(
      change === "arguments"
        ? [...documentCommand, "--no-auto-merge"]
        : documentCommand,
      fixture.dependencies,
    );

    assert.equal(result.summary.outcome, "cancelled");
    const current = await fixture.snapshot();
    assert.notEqual(current.input_hash, old.input_hash);
    assert.notEqual(current.execution_id, old.execution_id);
    assert.notEqual(current.worktree, old.worktree);
    assert.notEqual(current.invocation!.path, old.invocation!.path);
    assert.equal(fixture.maintenance.creates, 2);
    assert.deepEqual(fixture.dependencies.pauses, []);
    assert.deepEqual(
      await Promise.all(
        files.map((file) => readFile(path.join(recovery, file), "utf8")),
      ),
      saved,
    );
    await access(old.worktree);
    await access(old.probe!.path);
    assert.deepEqual(fixture.maintenance.cleanup, []);
  });
}
