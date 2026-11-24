/* eslint-disable @typescript-eslint/require-await -- Scripted external boundaries. */
import assert from "node:assert/strict";
import { readFile, readdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { hashRunInput, type BatchProgress } from "../../src/recovery.ts";
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
  fixture.dependencies.signal = new AbortController().signal;

  const result = await fixture.run();

  assert.equal(result.summary.outcome, "incomplete", JSON.stringify(result));
  assert.deepEqual(first.sort(), [51, 52]);
  assert.deepEqual(
    [...fixture.dispatched].slice(first.length).sort(),
    [53, 54],
  );
  assert.deepEqual(
    (JSON.parse(await readFile(batchFile, "utf8")) as BatchProgress).tickets,
    [53, 54],
  );
});

await test("an old-format Batch checkpoint is ignored rather than adopted", async (t) => {
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
  const oldHash = hashRunInput(
    fixture.dependencies.commandName,
    ["run", "--project", "demo", "--parent", "48"],
    await readFile(path.join(fixture.directory, "config.yaml")),
  );
  const oldFile = path.join(recovery, `${oldHash}-batch.json`);
  const old = JSON.stringify({
    ...saved,
    input_hash: oldHash,
    tickets: [52],
    checkpoint_version: undefined,
    run_scope: undefined,
  });
  await writeFile(oldFile, old);
  await rm(path.join(recovery, current));
  fixture.dependencies.tracker.addLabel = addLabel;
  fixture.dependencies.signal = new AbortController().signal;

  const result = await fixture.run();

  assert.notEqual(result.summary.outcome, "failed", result.summary.failure);
  assert.deepEqual(fixture.dispatched, [51]);
  assert.equal(await readFile(oldFile, "utf8"), old);
});
