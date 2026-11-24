/* eslint-disable @typescript-eslint/require-await -- Scripted external boundaries. */
import assert from "node:assert/strict";
import { access, mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { implementationRun, publish } from "../support/implementation-run.ts";
import {
  documentCommand,
  documentationRun,
} from "../support/documentation-run.ts";

for (const field of ["checksStartedAt", "mergeStartedAt"] as const) {
  await test(`recovery rejects a negative ${field} timeout basis`, async (t) => {
    const fixture = await implementationRun(t);
    assert.match(
      (await fixture.run()).summary.tickets![0]!.detail,
      /CI-ready/u,
    );
    const saved = await fixture.snapshot();
    const recovery = path.join(fixture.directory, "recovery");
    const [file] = await readdir(recovery);
    await publish(path.join(recovery, file!), {
      ...saved,
      publication: { ...saved.publication!, [field]: -1 },
    });
    fixture.dependencies.signal = new AbortController().signal;
    fixture.dependencies.operator.pause = async (message) => {
      assert.match(message, /restart the entire Issue #50/u);
      return "q";
    };
    const result = await fixture.run();
    assert.equal(result.summary.outcome, "cancelled");
    assert.ok(fixture.dependencies.messages.includes("unable to recover"));
  });
}

await test("an execution checkpoint from another input scope cannot resume or overwrite retained work", async (t) => {
  const fixture = await implementationRun(t);
  assert.equal((await fixture.run()).summary.outcome, "incomplete");
  const saved = await fixture.snapshot();
  const recovery = path.join(fixture.directory, "recovery");
  const file = path.join(recovery, (await readdir(recovery))[0]!);
  const submissions = fixture.state.submissions.length;
  for (const patch of [
    { input_hash: "another-input" },
    { checkpoint_version: 2 },
    { run_scope: { ...saved.run_scope, targetBranch: "other-branch" } },
    { repository: ["owner/repo"] },
    { project: "another-project" },
    { purpose: "documentation" },
    { reservation: null },
  ]) {
    const text = JSON.stringify({ ...saved, ...patch });
    await writeFile(file, text);
    fixture.dependencies.operator.pause = async (message) => {
      assert.equal(
        message,
        "Enter to restart the entire Issue #50, or q to exit Runner.",
      );
      return "q";
    };
    const result = await fixture.run();
    assert.equal(result.summary.outcome, "cancelled", JSON.stringify(result));
    assert.ok(fixture.dependencies.messages.includes("unable to recover"));
    assert.equal(await readFile(file, "utf8"), text);
    assert.equal(fixture.state.submissions.length, submissions);
    assert.deepEqual(fixture.state.cleanup, []);
  }
});

await test("an open Issue with replacement Reservation IDs cannot continue a saved execution", async (t) => {
  const fixture = await implementationRun(t);
  assert.equal((await fixture.run()).summary.outcome, "incomplete");
  const { tracker } = fixture.dependencies;
  const read = tracker.readIssueStart.bind(tracker);
  tracker.readIssueStart = async (...args) => {
    const facts = await read(...args);
    const replacement = { ...facts.reservation!, id: "replacement-label" };
    facts.issue.labels = facts.issue.labels.map((label) =>
      label.name === replacement.name ? replacement : label,
    );
    return { ...facts, reservation: replacement };
  };
  tracker.reserveIssue = async () =>
    assert.fail("unexpected Reservation write");
  const result = await fixture.run();
  assert.equal(result.summary.outcome, "incomplete");
  assert.match(
    result.summary.tickets![0]!.detail,
    /Recorded Reservation changed/u,
  );
  assert.equal(fixture.state.taskCount, 1);
  assert.deepEqual(fixture.dependencies.pauses, []);
});

await test("a failed atomic checkpoint write preserves the last valid invocation without serializing tab handles", async (t) => {
  const fixture = await implementationRun(t);
  const createTab = fixture.dependencies.terminalPlugin.createTab.bind(
    fixture.dependencies.terminalPlugin,
  );
  fixture.dependencies.terminalPlugin.createTab = async (options) => ({
    ...(await createTab(options)),
    toJSON() {
      assert.fail("opaque tab handles must never be serialized");
    },
  });
  fixture.state.onTask = async () => {
    fixture.controller.abort();
  };
  assert.equal((await fixture.run()).summary.outcome, "cancelled");
  const saved = await fixture.snapshot();
  const recovery = path.join(fixture.directory, "recovery");
  const file = path.join(recovery, (await readdir(recovery))[0]!);
  const text = await readFile(file, "utf8");
  await publish(saved.invocation!.path, {});
  await mkdir(`${file}.tmp`);
  fixture.dependencies.signal = new AbortController().signal;
  fixture.state.onSleep = async (ms) => {
    assert.ok(ms > 0);
  };
  fixture.dependencies.operator.pause = async (message) => {
    assert.match(message, /Operation failed/u);
    assert.ok(message.includes(`${file}.tmp`));
    return "q";
  };
  const result = await fixture.run();
  assert.equal(result.summary.outcome, "cancelled", JSON.stringify(result));
  assert.equal(await readFile(file, "utf8"), text);
  assert.equal(fixture.state.taskCount, 1);
  await access(saved.worktree);
  await access(saved.invocation!.path);
});

await test("standalone documentation checkpoints are owned by their Run scope", async (t) => {
  const fixture = await documentationRun(t);
  fixture.state.onTask = async () => {
    fixture.controller.abort();
  };
  assert.equal((await fixture.run()).summary.outcome, "cancelled");
  const recovery = path.join(fixture.directory, "recovery");
  for (const name of await readdir(recovery)) {
    const file = path.join(recovery, name);
    const saved = JSON.parse(await readFile(file, "utf8")) as Record<
      string,
      unknown
    >;
    assert.deepEqual(saved.run_arguments, documentCommand);
    assert.equal(saved.input_hash, name.split("-")[0]);
  }
  const name = (await readdir(recovery)).find((name) =>
    name.endsWith("-document.json"),
  )!;
  const file = path.join(recovery, name);
  const saved = JSON.parse(await readFile(file, "utf8")) as {
    run_scope?: Record<string, unknown>;
  };
  assert.ok(saved.run_scope);
  const text = JSON.stringify({
    ...saved,
    run_scope: { ...saved.run_scope, targetBranch: "other-branch" },
  });
  await writeFile(file, text);
  fixture.dependencies.signal = new AbortController().signal;
  fixture.dependencies.operator.pause = async (message) => {
    assert.match(message, /restart the entire Documentation Maintenance/u);
    return "q";
  };
  assert.equal((await fixture.run()).summary.outcome, "cancelled");
  assert.equal(fixture.maintenance.creates, 1);
  assert.equal(fixture.state.taskCount, 1);
  assert.equal(await readFile(file, "utf8"), text);
});
