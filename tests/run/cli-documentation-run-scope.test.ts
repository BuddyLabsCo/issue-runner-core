/* eslint-disable @typescript-eslint/require-await -- Scripted external boundaries. */
import assert from "node:assert/strict";
import { access, readFile, readdir, writeFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import type {
  BatchProgress,
  ImplementationProgress,
  MaintenanceProgress,
} from "../../src/recovery.ts";
import {
  batchDocumentationRun,
  documentationNoChange,
} from "../support/batch-documentation-run.ts";
import { documentationRun } from "../support/documentation-run.ts";
import {
  implementationProgress,
  publish,
} from "../support/implementation-run.ts";
import { child } from "../support/parent-run.ts";
import { updateConfig } from "../support/run-scope.ts";

async function checkpoint(
  directory: string,
  match: string | RegExp,
): Promise<{ file: string; text: string; value: Record<string, unknown> }> {
  const recovery = path.join(directory, "recovery");
  const name = (await readdir(recovery)).find((file) =>
    typeof match === "string" ? file.endsWith(match) : match.test(file),
  );
  assert.ok(name, `missing ${String(match)}`);
  const file = path.join(recovery, name);
  const text = await readFile(file, "utf8");
  return { file, text, value: JSON.parse(text) as Record<string, unknown> };
}

async function resumeDocumentation(
  fixture: Awaited<ReturnType<typeof documentationRun>>,
  saved: ImplementationProgress,
) {
  fixture.state.evidence.changed = false;
  fixture.state.evidence.commits = [];
  const submit = fixture.dependencies.terminalPlugin.onInput.bind(
    fixture.dependencies.terminalPlugin,
  );
  fixture.dependencies.terminalPlugin.onInput = async (tab, text, chord) => {
    await submit(tab, text, chord);
    if (text === "continue")
      await publish(saved.invocation!.path, documentationNoChange);
  };
}

await test("standalone documentation recovers after Review switch and Review-depth changes", async (t) => {
  for (const review of [
    { review: false, maxReviewRounds: 3 },
    { review: true, maxReviewRounds: 3 },
  ]) {
    const fixture = await documentationRun(t);
    fixture.state.onTask = async () => fixture.controller.abort();
    assert.equal((await fixture.run()).summary.outcome, "cancelled");
    const saved = await fixture.snapshot();
    const maintenance = await checkpoint(fixture.directory, "-document.json");
    const execution = await checkpoint(fixture.directory, "-document-50.json");
    assert.equal(maintenance.value.checkpoint_version, 1);
    assert.equal(execution.value.checkpoint_version, 1);
    assert.equal(
      (maintenance.value.run_scope as { selector: { kind: string } }).selector
        .kind,
      "document",
    );
    assert.equal(
      (maintenance.value.run_scope as { review?: unknown }).review,
      undefined,
    );
    assert.deepEqual(execution.value.run_scope, maintenance.value.run_scope);
    await updateConfig(fixture, (config) => ({
      ...config,
      workflow: review,
    }));
    fixture.dependencies.signal = new AbortController().signal;
    await resumeDocumentation(fixture, saved);

    const result = await fixture.run();

    assert.equal(result.summary.outcome, "succeeded", JSON.stringify(result));
    assert.equal((await fixture.snapshot()).execution_id, saved.execution_id);
    assert.equal(fixture.maintenance.creates, 1);
  }
});

for (const kind of ["maintenance", "execution"] as const) {
  await test(`standalone documentation rejects an old-format ${kind} checkpoint and retains its resources`, async (t) => {
    const fixture = await documentationRun(t);
    fixture.state.onTask = async () => fixture.controller.abort();
    assert.equal((await fixture.run()).summary.outcome, "cancelled");
    const saved = await fixture.snapshot();
    const target =
      kind === "maintenance"
        ? await checkpoint(fixture.directory, "-document.json")
        : await checkpoint(fixture.directory, "-document-50.json");
    const old = {
      ...target.value,
      checkpoint_version: undefined,
      run_scope: undefined,
    };
    const text = JSON.stringify(old);
    await writeFile(target.file, text);
    fixture.dependencies.signal = new AbortController().signal;
    fixture.dependencies.operator.pause = async (message) => {
      assert.match(message, /restart the entire Documentation Maintenance/u);
      return "q";
    };
    fixture.dependencies.terminalPlugin.onInput = async () => {
      assert.fail("an old-format checkpoint must not resume its Agent");
    };

    const result = await fixture.run();

    assert.equal(result.summary.outcome, "cancelled", JSON.stringify(result));
    assert.ok(fixture.dependencies.messages.includes("unable to recover"));
    assert.equal(await readFile(target.file, "utf8"), text);
    assert.equal(fixture.maintenance.creates, 1);
    assert.equal(fixture.state.taskCount, 1);
    await access(saved.worktree);
    await access(saved.probe!.path);
  });
}

await test("Parent-scheduled documentation inherits and follows its Parent Run scope", async (t) => {
  const fixture = await batchDocumentationRun(t, [
    child(51, { labels: ["ready-for-agent", "Docs"] }),
  ]);
  fixture.state.onDocument = async () => fixture.controller.abort();
  assert.equal((await fixture.run()).summary.outcome, "cancelled");
  const saved = await implementationProgress(fixture.directory, 100);
  const maintenance = await checkpoint(
    fixture.directory,
    /-document-batch-.+\.json$/u,
  );
  const batch = await checkpoint(fixture.directory, "-batch.json");
  const maintenanceProgress =
    maintenance.value as unknown as MaintenanceProgress;
  const batchProgress = batch.value as unknown as BatchProgress;
  assert.deepEqual(maintenanceProgress.run_scope, batchProgress.run_scope);
  assert.equal(maintenanceProgress.run_scope?.selector.kind, "parent");
  assert.equal(maintenanceProgress.run_scope?.review?.enabled, false);
  await updateConfig(fixture, (config) => ({
    ...config,
    workflow: { review: true, maxReviewRounds: 1 },
  }));
  fixture.dependencies.signal = new AbortController().signal;

  const result = await fixture.run();

  assert.notEqual(result.summary.outcome, "failed", JSON.stringify(result));
  assert.equal(await readFile(maintenance.file, "utf8"), maintenance.text);
  assert.equal(fixture.maintenance.length, 1);
  await access(saved.worktree);
  await access(saved.probe!.path);
});
