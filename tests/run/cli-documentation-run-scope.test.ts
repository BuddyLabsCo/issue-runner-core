/* eslint-disable @typescript-eslint/require-await -- Scripted external boundaries. */
import assert from "node:assert/strict";
import { access, readFile, readdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import {
  type BatchProgress,
  type ImplementationProgress,
  type MaintenanceProgress,
} from "../../src/recovery.ts";
import {
  batchDocumentationConfig,
  batchDocumentationRun,
  documentationNoChange,
} from "../support/batch-documentation-run.ts";
import {
  documentCommand,
  documentationRun,
} from "../support/documentation-run.ts";
import {
  implementationProgress,
  publish,
} from "../support/implementation-run.ts";
import { child } from "../support/parent-run.ts";
import { promptAssignment } from "../support/prompt-assignment.ts";
import { passed } from "../support/review-run.ts";
import { legacyRunInputHash, updateConfig } from "../support/run-scope.ts";

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
    const submit = fixture.dependencies.terminalPlugin.onInput.bind(
      fixture.dependencies.terminalPlugin,
    );
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

    if (kind === "maintenance") {
      fixture.dependencies.terminalPlugin.onInput = submit;
      fixture.state.onTask = async (file) => {
        fixture.state.evidence.changed = false;
        await publish(file, documentationNoChange);
      };
      fixture.dependencies.operator.pause = async (message) => {
        assert.match(message, /restart the entire Documentation Maintenance/u);
        return "";
      };
      fixture.dependencies.signal = new AbortController().signal;

      const restarted = await fixture.run();

      assert.equal(
        restarted.summary.outcome,
        "succeeded",
        JSON.stringify(restarted),
      );
      assert.equal(fixture.maintenance.creates, 2);
      const recovery = path.join(fixture.directory, "recovery");
      const archived = (await readdir(recovery)).find(
        (name) =>
          name.startsWith(`${path.basename(target.file)}.`) &&
          name.endsWith(".retained"),
      );
      assert.ok(archived, "the rejected maintenance checkpoint is archived");
      assert.equal(await readFile(path.join(recovery, archived), "utf8"), text);
      await access(saved.worktree);
      await access(saved.probe!.path);
    }
  });
}

await test("old-format standalone checkpoints are ignored at their pre-upgrade path", async (t) => {
  const fixture = await documentationRun(t);
  fixture.state.onTask = async () => fixture.controller.abort();
  assert.equal((await fixture.run()).summary.outcome, "cancelled");
  const saved = await fixture.snapshot();
  const maintenance = await checkpoint(fixture.directory, "-document.json");
  const execution = await checkpoint(fixture.directory, "-document-50.json");
  const oldHash = legacyRunInputHash(
    fixture.dependencies.commandName,
    documentCommand,
    await readFile(path.join(fixture.directory, "config.yaml")),
  );
  assert.notEqual(oldHash, saved.input_hash);
  await rm(maintenance.file);
  await rm(execution.file);
  const oldMaintenance = {
    ...maintenance.value,
    checkpoint_version: undefined,
    run_scope: undefined,
    input_hash: oldHash,
  };
  const oldExecution = {
    ...execution.value,
    checkpoint_version: undefined,
    run_scope: undefined,
    input_hash: oldHash,
  };
  const recovery = path.join(fixture.directory, "recovery");
  const maintenanceFile = path.join(recovery, `${oldHash}-document.json`);
  const executionFile = path.join(recovery, `${oldHash}-document-50.json`);
  const maintenanceText = JSON.stringify(oldMaintenance);
  const executionText = JSON.stringify(oldExecution);
  await writeFile(maintenanceFile, maintenanceText);
  await writeFile(executionFile, executionText);
  fixture.state.onTask = async (file) => {
    fixture.state.evidence.changed = false;
    await publish(file, documentationNoChange);
  };
  fixture.dependencies.signal = new AbortController().signal;

  const result = await fixture.run();

  assert.equal(result.summary.outcome, "succeeded", JSON.stringify(result));
  assert.equal(fixture.maintenance.creates, 2);
  const current = await fixture.snapshot();
  assert.notEqual(current.execution_id, saved.execution_id);
  assert.notEqual(current.input_hash, oldHash);
  assert.equal(await readFile(maintenanceFile, "utf8"), maintenanceText);
  assert.equal(await readFile(executionFile, "utf8"), executionText);
  await access(saved.worktree);
  await access(saved.probe!.path);
});

for (const selector of ["parent", "issue"] as const) {
  await test(`a ${selector} Batch starts new documentation after its Review scope changes`, async (t) => {
    const fixture = await batchDocumentationRun(
      t,
      [51, 52, 53].map((number) =>
        child(number, { labels: ["ready-for-agent", "Docs"] }),
      ),
      {
        ...batchDocumentationConfig,
        issueList: [51, 52, 53],
        maxBatchSize: 2,
        workflow: {
          review: true,
          maxReviewRounds: 1,
          docMaintainTriggerLabel: "Docs",
        },
      },
    );
    const submit = fixture.dependencies.terminalPlugin.onInput.bind(
      fixture.dependencies.terminalPlugin,
    );
    fixture.dependencies.terminalPlugin.onInput = async (tab, text, chord) => {
      if (text.startsWith("Review assignment\n")) {
        const { ticket } = promptAssignment(text) as { ticket: number };
        const progress = await implementationProgress(
          fixture.directory,
          ticket,
        );
        await publish(progress.reviews!.at(-1)!.invocation!.path, passed());
        return;
      }
      await submit(tab, text, chord);
    };
    fixture.state.onDocument = async () => fixture.controller.abort();
    const run = () =>
      selector === "issue" ? fixture.run(["--issue"]) : fixture.run();
    const first = await run();
    assert.equal(
      first.summary.outcome,
      "cancelled",
      JSON.stringify(first.summary),
    );
    const saved = await implementationProgress(fixture.directory, 100);
    const maintenance = await checkpoint(
      fixture.directory,
      /-document-batch-.+\.json$/u,
    );
    const maintenanceProgress =
      maintenance.value as unknown as MaintenanceProgress;
    const batch = await checkpoint(fixture.directory, "-batch.json");
    const batchProgress = batch.value as unknown as BatchProgress;
    assert.deepEqual(maintenanceProgress.run_scope, batchProgress.run_scope);
    assert.equal(maintenanceProgress.run_scope?.selector.kind, selector);
    assert.deepEqual(maintenanceProgress.run_scope?.review, {
      enabled: true,
      maxReviewRounds: 1,
    });
    await updateConfig(fixture, (config) => ({
      ...config,
      workflow: {
        review: true,
        maxReviewRounds: 2,
        docMaintainTriggerLabel: "Docs",
      },
    }));
    fixture.dependencies.signal = new AbortController().signal;
    fixture.state.onDocument = (file) => publish(file, documentationNoChange);

    const result = await run();

    assert.equal(result.summary.outcome, "succeeded", JSON.stringify(result));
    assert.equal(fixture.maintenance.length, 2);
    const current = await implementationProgress(fixture.directory, 101);
    assert.notEqual(current.execution_id, saved.execution_id);
    assert.notEqual(current.input_hash, saved.input_hash);
    assert.equal(current.run_scope?.selector.kind, selector);
    assert.deepEqual(current.run_scope?.review, {
      enabled: true,
      maxReviewRounds: 2,
    });
    const next = await checkpoint(
      fixture.directory,
      new RegExp(`^${current.input_hash}-document-batch-.+\\.json$`, "u"),
    );
    assert.deepEqual(
      (next.value as unknown as MaintenanceProgress).run_scope,
      current.run_scope,
    );
    assert.equal(await readFile(maintenance.file, "utf8"), maintenance.text);
    await access(saved.worktree);
    await access(saved.probe!.path);
  });
}
