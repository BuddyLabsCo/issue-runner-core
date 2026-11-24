/* eslint-disable @typescript-eslint/require-await -- Scripted external boundaries. */
import assert from "node:assert/strict";
import { readFile, readdir, writeFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import type { BatchProgress } from "../../src/recovery.ts";
import { validConfig } from "../support/cli-project.ts";
import { child, parentRun } from "../support/parent-run.ts";
import { updateConfig } from "../support/run-scope.ts";

await test("a recorded unfinished Batch keeps every member when maxBatchSize is lowered", async (t) => {
  const tickets = [child(51), child(52), child(53)];
  const fixture = await parentRun(t, tickets, {
    ...validConfig,
    maxBatchSize: 2,
  });
  const addLabel = fixture.dependencies.tracker.addLabel.bind(
    fixture.dependencies.tracker,
  );
  fixture.dependencies.tracker.addLabel = async () => {
    fixture.controller.abort();
  };
  assert.equal((await fixture.run()).summary.outcome, "cancelled");
  const recovery = path.join(fixture.directory, "recovery");
  const [file] = (await readdir(recovery)).filter((name) =>
    name.endsWith("-batch.json"),
  );
  const batchFile = path.join(recovery, file!);
  assert.deepEqual(
    (JSON.parse(await readFile(batchFile, "utf8")) as BatchProgress).tickets,
    [51, 52],
  );
  await updateConfig(fixture, (config) => ({
    ...config,
    maxBatchSize: 1,
  }));
  fixture.dependencies.tracker.addLabel = addLabel;
  fixture.dependencies.signal = new AbortController().signal;

  const result = await fixture.run();

  assert.notEqual(result.summary.outcome, "failed", result.summary.failure);
  assert.deepEqual([...fixture.dispatched].slice(0, 2).sort(), [51, 52]);
  assert.deepEqual(
    (JSON.parse(await readFile(batchFile, "utf8")) as BatchProgress).tickets,
    [51, 52],
  );
});

await test("a new Batch selection uses the current maxBatchSize", async (t) => {
  const tickets = [child(51), child(52), child(53), child(54)];
  const fixture = await parentRun(t, tickets, {
    ...validConfig,
    maxBatchSize: 2,
  });
  assert.equal((await fixture.run()).summary.outcome, "incomplete");
  const first = [...fixture.dispatched];
  const recovery = path.join(fixture.directory, "recovery");
  const batchFile = path.join(
    recovery,
    (await readdir(recovery)).find((name) => name.endsWith("-batch.json"))!,
  );
  const batch = JSON.parse(await readFile(batchFile, "utf8")) as BatchProgress;
  for (const ticket of tickets.slice(0, 2)) {
    ticket.state = "closed";
    ticket.stateReason = "completed";
  }
  await writeFile(batchFile, JSON.stringify({ ...batch, completed: true }));
  await updateConfig(fixture, (config) => ({
    ...config,
    maxBatchSize: 1,
  }));
  fixture.dependencies.signal = new AbortController().signal;

  const result = await fixture.run();

  assert.equal(result.summary.outcome, "incomplete", JSON.stringify(result));
  assert.deepEqual(first.sort(), [51, 52]);
  assert.deepEqual([...fixture.dispatched].slice(first.length), [53]);
  assert.deepEqual(
    (JSON.parse(await readFile(batchFile, "utf8")) as BatchProgress).tickets,
    [53],
  );
});

await test("a live old-format Batch checkpoint fails closed and is retained", async (t) => {
  const tickets = [child(51), child(52)];
  const fixture = await parentRun(t, tickets, {
    ...validConfig,
    maxBatchSize: 1,
  });
  const addLabel = fixture.dependencies.tracker.addLabel.bind(
    fixture.dependencies.tracker,
  );
  fixture.dependencies.tracker.addLabel = async () => {
    fixture.controller.abort();
  };
  assert.equal((await fixture.run()).summary.outcome, "cancelled");
  const recovery = path.join(fixture.directory, "recovery");
  const current = (await readdir(recovery)).find((name) =>
    name.endsWith("-batch.json"),
  )!;
  const saved = JSON.parse(
    await readFile(path.join(recovery, current), "utf8"),
  ) as BatchProgress;
  const batchFile = path.join(recovery, current);
  const old = JSON.stringify({
    ...saved,
    checkpoint_version: undefined,
    run_scope: undefined,
  });
  await writeFile(batchFile, old);
  fixture.dependencies.tracker.addLabel = addLabel;
  fixture.dependencies.signal = new AbortController().signal;

  const result = await fixture.run();

  assert.equal(result.summary.outcome, "failed");
  assert.match(result.summary.failure!, /invalid Batch checkpoint/u);
  assert.deepEqual(fixture.dispatched, []);
  assert.equal(await readFile(batchFile, "utf8"), old);
});
