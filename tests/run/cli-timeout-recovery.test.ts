/* eslint-disable @typescript-eslint/require-await -- Scripted external boundaries. */
import assert from "node:assert/strict";
import { readdir, writeFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { stringify } from "yaml";
import { integrationRun } from "../support/integration-run.ts";
import { publicationRun } from "../support/publication-run.ts";
import { validConfig } from "../support/cli-project.ts";

async function checkpointFile(directory: string): Promise<string> {
  const recovery = path.join(directory, "recovery");
  const file = (await readdir(recovery)).find((name) =>
    name.endsWith("-50.json"),
  );
  assert.ok(file);
  return path.join(recovery, file);
}

for (const basis of ["recorded", "missing"] as const) {
  await test(`recovered required-checks wait uses the current timeout with a ${basis} start`, async (t) => {
    const fixture = await publicationRun(t);
    fixture.publicationState.checks = [
      { name: "build", state: "PENDING", link: "", bucket: "pending" },
    ];
    fixture.state.onSleep = async () => {
      if ((await fixture.snapshot()).publication?.checksDeadline !== undefined)
        fixture.controller.abort();
    };
    assert.equal((await fixture.run()).summary.outcome, "cancelled");
    const saved = (await fixture.snapshot()).publication!;
    assert.notEqual(saved.checksDeadline, undefined);
    assert.notEqual(saved.checksStartedAt, undefined);
    if (basis === "missing") {
      const checkpoint = await fixture.snapshot();
      delete checkpoint.publication!.checksStartedAt;
      await writeFile(
        await checkpointFile(fixture.directory),
        JSON.stringify(checkpoint),
      );
    }
    await writeFile(
      path.join(fixture.directory, "config.yaml"),
      stringify({
        ...validConfig,
        workflow: { review: false },
        timeouts: { ...validConfig.timeouts, requiredChecksMinutes: 0.25 },
      }),
    );
    fixture.dependencies.signal = new AbortController().signal;
    const startedAt =
      basis === "recorded"
        ? saved.checksStartedAt!
        : fixture.dependencies.clock.now().getTime();
    let checked = false;
    fixture.state.onSleep = async () => {
      if (checked) return;
      checked = true;
      const publication = (await fixture.snapshot()).publication!;
      assert.equal(publication.checksDeadline, startedAt + 15_000);
    };
    fixture.dependencies.operator.pause = async (message) => {
      assert.match(message, /Required checks timed out/u);
      fixture.publicationState.checks[0]!.bucket = "pass";
      return "";
    };
    const result = await fixture.run();
    assert.match(result.summary.tickets![0]!.detail, /CI-ready/u);
    assert.equal(checked, true);
  });
}

for (const basis of ["recorded", "missing"] as const) {
  await test(`recovered merge wait uses the current timeout with a ${basis} start`, async (t) => {
    const fixture = await integrationRun(t);
    fixture.integrationState.onMerge = async () => {
      fixture.integrationState.pullRequest.mergeRequested = true;
      throw new Error("queue response lost");
    };
    fixture.state.onSleep = async () => {
      if (fixture.integrationState.pullRequest.mergeRequested)
        fixture.controller.abort();
    };
    assert.equal((await fixture.run()).summary.outcome, "cancelled");
    const saved = (await fixture.snapshot()).publication!;
    assert.equal(saved.phase, "merge_requested");
    assert.notEqual(saved.mergeStartedAt, undefined);
    if (basis === "missing") {
      const checkpoint = await fixture.snapshot();
      delete checkpoint.publication!.mergeStartedAt;
      await writeFile(
        await checkpointFile(fixture.directory),
        JSON.stringify(checkpoint),
      );
    }
    await writeFile(
      path.join(fixture.directory, "config.yaml"),
      stringify({
        ...validConfig,
        workflow: { review: false },
        timeouts: { ...validConfig.timeouts, mergeQueueMinutes: 0.25 },
      }),
    );
    fixture.dependencies.signal = new AbortController().signal;
    const startedAt =
      basis === "recorded"
        ? saved.mergeStartedAt!
        : fixture.dependencies.clock.now().getTime();
    let checked = false;
    fixture.state.onSleep = async () => {
      if (checked) return;
      checked = true;
      const publication = (await fixture.snapshot()).publication!;
      assert.equal(publication.mergeDeadline, startedAt + 15_000);
    };
    fixture.dependencies.operator.pause = async (message) => {
      assert.match(message, /Merge confirmation timed out/u);
      fixture.integrationState.pullRequest.merged = true;
      return "";
    };
    const result = await fixture.run();
    assert.equal(result.summary.outcome, "succeeded", JSON.stringify(result));
    assert.equal(fixture.integrationState.requests.length, 1);
    assert.equal(checked, true);
  });
}
