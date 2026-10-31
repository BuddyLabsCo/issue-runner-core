import assert from "node:assert/strict";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import type {
  BatchProgress,
  ImplementationProgress,
} from "../../src/recovery.ts";
import {
  batchDocumentationConfig,
  batchDocumentationRun,
} from "../support/batch-documentation-run.ts";
import { implementationProgress } from "../support/implementation-run.ts";
import { child } from "../support/parent-run.ts";

await test("Issue List recovery continues after delivery persisted before its maintenance association", async (t) => {
  const tickets = [51, 52].map((number) =>
    child(number, { labels: ["ready-for-agent", "Docs"] }),
  );
  const fixture = await batchDocumentationRun(t, tickets, {
    ...batchDocumentationConfig,
    issueList: [51, 52],
    maxBatchSize: 1,
  });
  const recovery = path.join(fixture.directory, "recovery");
  const now = fixture.dependencies.clock.now.bind(fixture.dependencies.clock);
  fixture.dependencies.clock.now = () => {
    const file = existsSync(recovery)
      ? readdirSync(recovery).find((file) => file.endsWith("-51.json"))
      : undefined;
    if (file) {
      const progress = JSON.parse(
        readFileSync(path.join(recovery, file), "utf8"),
      ) as ImplementationProgress;
      if (progress.publication?.phase === "delivered")
        fixture.controller.abort();
    }
    return now();
  };

  assert.equal((await fixture.run(["--issue"])).summary.outcome, "cancelled");
  assert.equal(
    (await implementationProgress(fixture.directory, 51)).publication?.phase,
    "delivered",
  );
  const batchFile = readdirSync(recovery).find((file) =>
    file.endsWith("-batch.json"),
  )!;
  const batch = JSON.parse(
    readFileSync(path.join(recovery, batchFile), "utf8"),
  ) as BatchProgress;
  assert.equal(batch.documentation, undefined);
  assert.equal(fixture.maintenance.length, 0);
  assert.equal(tickets[1]!.state, "open");
  fixture.dependencies.clock.now = now;
  fixture.dependencies.signal = new AbortController().signal;

  const result = await fixture.run(["--issue"]);

  assert.equal(result.summary.outcome, "succeeded", JSON.stringify(result));
  assert.equal(result.exitCode, 0);
  assert.ok(tickets.every((ticket) => ticket.stateReason === "completed"));
  assert.deepEqual(fixture.dispatched, [51, 52]);
  assert.equal(fixture.maintenance.length, 2);
  assert.deepEqual(fixture.events, [
    "implement",
    "close:51",
    "maintenance:100",
    "document",
    "close:100",
    "implement",
    "close:52",
    "maintenance:101",
    "document",
    "close:101",
  ]);
});
