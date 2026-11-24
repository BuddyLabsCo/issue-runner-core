/* eslint-disable @typescript-eslint/require-await -- Scripted external boundaries. */
import assert from "node:assert/strict";
import { access, writeFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { documentationRun } from "../support/documentation-run.ts";
import { reviewRun } from "../support/review-run.ts";
import { conflictRepairRun } from "../support/conflict-repair-run.ts";
import { implementationRun } from "../support/implementation-run.ts";
import { updateConfig } from "../support/run-scope.ts";

await test("a changed recorded Review identity requires an explicit restart", async (t) => {
  const fixture = await reviewRun(t);
  fixture.reviewState.onReview = async () => fixture.controller.abort();
  assert.equal((await fixture.run()).summary.outcome, "cancelled");
  const saved = await fixture.snapshot();
  assert.deepEqual(saved.roles.review, {
    sessionid: "review-native/$&",
    agent: "review-agent",
    resume: 'review-cli resume "review-native/$&"',
  });
  await updateConfig(fixture, (config) => ({
    ...config,
    agents: {
      ...(config.agents as Record<string, unknown>),
      review: {
        ...(config.agents as Record<string, Record<string, unknown>>).review,
        agent: "changed-review-agent",
      },
    },
  }));
  fixture.dependencies.signal = new AbortController().signal;
  fixture.dependencies.operator.pause = async () => "q";
  const result = await fixture.run();
  assert.equal(result.summary.outcome, "cancelled");
  assert.ok(fixture.dependencies.messages.includes("unable to recover"));
  await access(saved.worktree);
  assert.deepEqual(fixture.state.cleanup, []);
});

await test("a changed recorded Documentation identity requires an explicit restart", async (t) => {
  const fixture = await documentationRun(t);
  fixture.state.onTask = async () => fixture.controller.abort();
  assert.equal((await fixture.run()).summary.outcome, "cancelled");
  const saved = await fixture.snapshot();
  assert.equal(saved.roles.documentation?.agent, "document-agent");
  const file = path.join(
    fixture.directory,
    "recovery",
    `${saved.input_hash}-document-50.json`,
  );
  await writeFile(
    file,
    JSON.stringify({
      ...saved,
      roles: {
        documentation: {
          ...saved.roles.documentation,
          agent: "changed-document-agent",
        },
      },
    }),
  );
  fixture.dependencies.signal = new AbortController().signal;
  fixture.dependencies.operator.pause = async () => "q";
  const result = await fixture.run();
  assert.equal(result.summary.outcome, "cancelled");
  assert.ok(fixture.dependencies.messages.includes("unable to recover"));
  await access(saved.worktree);
  assert.deepEqual(fixture.maintenance.cleanup, []);
});

await test("a recorded role missing from current configuration requires an explicit restart", async (t) => {
  const fixture = await implementationRun(t);
  fixture.state.onTask = async () => fixture.controller.abort();
  assert.equal((await fixture.run()).summary.outcome, "cancelled");
  const saved = await fixture.snapshot();
  await writeFile(
    path.join(fixture.directory, "recovery", `${saved.input_hash}-50.json`),
    JSON.stringify({
      ...saved,
      roles: {
        ...saved.roles,
        documentation: {
          sessionid: "document-native",
          agent: "document-agent",
          resume: 'document-cli --resume "document-native"',
        },
      },
    }),
  );
  fixture.dependencies.signal = new AbortController().signal;
  fixture.dependencies.operator.pause = async () => "q";
  const result = await fixture.run();
  assert.equal(result.summary.outcome, "cancelled");
  assert.ok(fixture.dependencies.messages.includes("unable to recover"));
  await access(saved.worktree);
});

await test("a changed recorded conflict repair identity requires an explicit restart", async (t) => {
  const fixture = await conflictRepairRun(t);
  fixture.repairs.onTask = async () => fixture.controller.abort();
  assert.equal((await fixture.run()).summary.outcome, "cancelled");
  const saved = await fixture.snapshot();
  const attempt = saved.publication!.conflictRepair!.attempts.at(-1)!;
  assert.ok(attempt.agent);
  assert.ok(attempt.resume);
  await updateConfig(fixture, (config) => ({
    ...config,
    agents: {
      ...(config.agents as Record<string, unknown>),
      conflictRepair: {
        ...(config.agents as Record<string, Record<string, unknown>>)
          .conflictRepair,
        resume: 'changed-conflict --resume "{sessionref}"',
      },
    },
  }));
  fixture.dependencies.signal = new AbortController().signal;
  fixture.dependencies.operator.pause = async () => "q";
  const result = await fixture.run();
  assert.equal(result.summary.outcome, "cancelled");
  assert.ok(fixture.dependencies.messages.includes("unable to recover"));
  await access(attempt.worktree);
});
