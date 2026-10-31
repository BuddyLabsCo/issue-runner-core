/* eslint-disable @typescript-eslint/require-await -- Scripted external boundaries. */
import assert from "node:assert/strict";
import { access, readFile, readdir, writeFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import type { BatchProgress, MaintenanceProgress } from "../../src/recovery.ts";
import {
  batchDocumentationRun,
  documentationNoChange,
} from "../support/batch-documentation-run.ts";
import {
  implementationProgress,
  publish,
} from "../support/implementation-run.ts";
import { child } from "../support/parent-run.ts";

await test("completed documentation from another Run cannot satisfy a Batch closure barrier", async (t) => {
  const fixture = await batchDocumentationRun(t, [
    child(51, { labels: ["ready-for-agent", "Docs"] }),
  ]);
  assert.equal((await fixture.run()).summary.outcome, "succeeded");
  const recovery = path.join(fixture.directory, "recovery");
  const files = await readdir(recovery);
  const batchFile = path.join(
    recovery,
    files.find((file) => file.endsWith("-batch.json"))!,
  );
  const batch = JSON.parse(await readFile(batchFile, "utf8")) as BatchProgress;
  delete batch.completed;
  await writeFile(batchFile, JSON.stringify(batch));
  const occurrenceFile = path.join(
    recovery,
    files.find((file) =>
      file.endsWith(`-document-batch-${batch.documentation}.json`),
    )!,
  );
  const occurrence = JSON.parse(
    await readFile(occurrenceFile, "utf8"),
  ) as MaintenanceProgress;
  assert.equal(occurrence.phase, "completed");
  const unrelated = JSON.stringify({ ...occurrence, run_id: "another-run" });
  await writeFile(occurrenceFile, unrelated);
  fixture.dependencies.operator.pause = async (message) => {
    assert.equal(
      message,
      "Enter to restart the entire Documentation Maintenance occurrence, or q to exit Runner.",
    );
    return "q";
  };
  fixture.dependencies.tracker.getParent = async () => {
    assert.fail(
      "unmatched maintenance must block parent discovery and closure",
    );
  };

  const result = await fixture.run();

  assert.equal(result.summary.outcome, "cancelled", JSON.stringify(result));
  assert.ok(fixture.dependencies.messages.includes("unable to recover"));
  assert.equal(await readFile(occurrenceFile, "utf8"), unrelated);
  assert.equal(fixture.maintenance.length, 1);
  assert.equal(
    (JSON.parse(await readFile(batchFile, "utf8")) as BatchProgress).completed,
    undefined,
  );
});

await test("restarted automatic documentation keeps its Batch association through another interruption", async (t) => {
  const fixture = await batchDocumentationRun(t, [
    child(51, { labels: ["ready-for-agent", "Docs"] }),
  ]);
  fixture.state.onDocument = async () => fixture.controller.abort();
  assert.equal((await fixture.run()).summary.outcome, "cancelled");
  const old = await implementationProgress(fixture.directory, 100);
  const recovery = path.join(fixture.directory, "recovery");
  const files = await readdir(recovery);
  const batchFile = path.join(
    recovery,
    files.find((file) => file.endsWith("-batch.json"))!,
  );
  const batch = JSON.parse(await readFile(batchFile, "utf8")) as BatchProgress;
  const oldFile = path.join(
    recovery,
    files.find((file) => file.endsWith("-document-100.json"))!,
  );
  const invalid = JSON.stringify({ ...old, branch: "unrelated-branch" });
  await writeFile(oldFile, invalid);
  await writeFile(`${old.invocation!.path}.tmp`, "unfinished old handoff");
  const controller = new AbortController();
  fixture.dependencies.signal = controller.signal;
  fixture.dependencies.operator.pause = async (message) => {
    assert.equal(
      message,
      "Enter to restart the entire Documentation Maintenance occurrence, or q to exit Runner.",
    );
    return "";
  };
  fixture.state.onDocument = async () => controller.abort();
  assert.equal((await fixture.run()).summary.outcome, "cancelled");
  const restarted = await implementationProgress(fixture.directory, 101);
  assert.equal(restarted.run_id, batch.run_id);
  assert.notEqual(restarted.execution_id, old.execution_id);
  assert.notEqual(restarted.worktree, old.worktree);
  assert.notEqual(restarted.invocation!.path, old.invocation!.path);
  assert.deepEqual(restarted.roles, {
    documentation: { sessionid: "native-101" },
  });
  assert.equal(restarted.corrections, 0);
  assert.deepEqual(restarted.superseded, []);
  fixture.dependencies.operator.pause = async () => {
    assert.fail(
      "the replacement occurrence must recover without another restart",
    );
  };
  const getParent = fixture.dependencies.tracker.getParent.bind(
    fixture.dependencies.tracker,
  );
  fixture.dependencies.tracker.getParent = async (...args) => {
    assert.equal(fixture.maintenance[1]!.stateReason, "completed");
    return getParent(...args);
  };
  fixture.dependencies.signal = new AbortController().signal;
  await publish(restarted.invocation!.path, documentationNoChange);

  const result = await fixture.run();

  assert.equal(result.summary.outcome, "succeeded", JSON.stringify(result));
  assert.equal(fixture.parent.stateReason, "completed");
  assert.equal(fixture.maintenance.length, 2);
  assert.equal(fixture.maintenance[0]!.state, "open");
  assert.equal(await readFile(oldFile, "utf8"), invalid);
  await access(old.worktree);
  await access(old.probe!.path);
  assert.equal(
    await readFile(`${old.invocation!.path}.tmp`, "utf8"),
    "unfinished old handoff",
  );
  assert.ok(!fixture.cleanup.includes(old.worktree));
});
