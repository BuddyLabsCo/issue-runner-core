/* eslint-disable @typescript-eslint/require-await -- Scripted external boundaries. */
import assert from "node:assert/strict";
import { readFile, readdir, writeFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { ciRepairRun, repairCommit } from "../support/ci-repair-run.ts";
import { publish } from "../support/implementation-run.ts";

await test("blocked repair output is corrected in the same native stage rather than revived as a blocked result", async (t) => {
  const fixture = await ciRepairRun(t);
  const repair = fixture.repairs.onTask;
  let calls = 0;
  fixture.repairs.onTask = async (file, evidence) => {
    if (++calls === 1)
      await publish(file, {
        outcome: "blocked",
        summary: "Need input",
        commits: [],
        findings_file: null,
      });
    else await repair(file, evidence);
  };
  assert.match((await fixture.run()).summary.reasons.join(" "), /CI-ready/u);
  const budget = (await fixture.snapshot()).publication!.ciRepair!;
  assert.equal(budget.consumed, 1);
  assert.equal(budget.attempts.length, 1);
  assert.equal(budget.attempts[0]!.corrections, 1);
  assert.equal(fixture.repairs.probes.length, 1);
  assert.equal(fixture.state.closedTabs.length, 2);
});

await test("repair Worktree creation interrupted after its side effect reconciles the recorded empty workspace", async (t) => {
  const fixture = await ciRepairRun(t);
  const create = fixture.dependencies.gitWorkspace.createWorktree.bind(
    fixture.dependencies.gitWorkspace,
  );
  let repairCreates = 0;
  fixture.dependencies.gitWorkspace.createWorktree = async (input) => {
    await create(input);
    if (input.branch.includes("ci-repair") && ++repairCreates === 1)
      fixture.controller.abort();
  };
  assert.equal((await fixture.run()).summary.outcome, "cancelled");
  const pending = (await fixture.snapshot()).publication!.ciRepair!
    .attempts[0]!;
  assert.equal(pending.worktreeCreated, undefined);
  fixture.dependencies.signal = new AbortController().signal;
  assert.match((await fixture.run()).summary.reasons.join(" "), /CI-ready/u);
  assert.equal(repairCreates, 1);
  assert.equal(
    (await fixture.snapshot()).publication!.ciRepair!.attempts[0]!.attempt_id,
    pending.attempt_id,
  );
});

await test("unexpected remote advancement after repair completion never overwrites remote work", async (t) => {
  const fixture = await ciRepairRun(t);
  fixture.state.onClose = async () => {
    if (fixture.state.closedTabs.length === 2) {
      const saved = await fixture.snapshot();
      fixture.publicationState.branches.set(saved.branch, "d".repeat(40));
    }
  };
  fixture.dependencies.operator.pause = async (message) => {
    assert.match(message, /advanced/u);
    return "q";
  };
  assert.equal((await fixture.run()).summary.outcome, "cancelled");
  assert.equal(fixture.publicationState.pushes, 1);
  const budget = (await fixture.snapshot()).publication!.ciRepair!;
  assert.equal(budget.consumed, 1);
  assert.equal(budget.attempts[0]!.pendingPush, repairCommit.sha);
});

await test("restart preserves an exhausted CI generation until the operator authorizes retry", async (t) => {
  const fixture = await ciRepairRun(t);
  fixture.repairs.onTask = async (file) => {
    await publish(file, {
      outcome: "no_change",
      summary: "No repair",
      commits: [],
      findings_file: null,
    });
  };
  let pauses = 0;
  fixture.dependencies.operator.pause = async (message) => {
    assert.match(message, /CI repair failed after two attempts/u);
    pauses++;
    return "q";
  };
  assert.equal((await fixture.run()).summary.outcome, "cancelled");
  fixture.dependencies.signal = new AbortController().signal;
  assert.equal((await fixture.run()).summary.outcome, "cancelled");
  assert.equal(pauses, 2);
  assert.equal(fixture.repairs.tasks.length, 2);
  assert.equal((await fixture.snapshot()).publication!.ciRepair!.generation, 0);
});

await test("repair pushes retain the discovery deadline across cancellation and recovery", async (t) => {
  const fixture = await ciRepairRun(t);
  fixture.state.onSleep = async (ms) => {
    if (ms === 30_000 && fixture.publicationState.pushes === 2)
      fixture.controller.abort();
  };
  assert.equal((await fixture.run()).summary.outcome, "cancelled");
  const before = await fixture.snapshot();
  assert.equal(before.publication!.ciRepair!.attempts[0]!.pushed, true);
  assert.equal(fixture.publicationState.discoveries.length, 1);
  fixture.dependencies.signal = new AbortController().signal;
  fixture.state.onSleep = async () => {
    /* Cancellation is disabled for recovery. */
  };
  assert.match((await fixture.run()).summary.reasons.join(" "), /CI-ready/u);
  assert.equal(fixture.publicationState.pushes, 2);
  assert.equal(
    (await fixture.snapshot()).publication!.discoveryNotBefore,
    before.publication!.discoveryNotBefore,
  );
});

await test("recovery rejects corrupted repair ownership, pending evidence, and budget before dispatch", async (t) => {
  const fixture = await ciRepairRun(t);
  fixture.state.onClose = async () => {
    if (fixture.state.closedTabs.length === 2) fixture.controller.abort();
  };
  assert.equal((await fixture.run()).summary.outcome, "cancelled");
  const directory = path.join(fixture.directory, "recovery");
  const file = path.join(directory, (await readdir(directory))[0]!);
  const original = await readFile(file, "utf8");
  const submissions = fixture.state.submissions.length;
  for (const field of [
    "worktree",
    "pendingPush",
    "consumed",
    "sessionid",
    "invocation",
  ] as const) {
    const saved = JSON.parse(original) as Awaited<
      ReturnType<typeof fixture.snapshot>
    >;
    const budget = saved.publication!.ciRepair!;
    const attempt = budget.attempts[0]!;
    if (field === "worktree")
      attempt.worktree = path.join(fixture.directory, "unrelated");
    else if (field === "pendingPush") attempt.pendingPush = "d".repeat(40);
    else if (field === "consumed") budget.consumed = 0;
    else if (field === "sessionid") delete attempt.sessionid;
    else
      attempt.invocation!.path = path.join(fixture.directory, "unowned.json");
    await writeFile(file, JSON.stringify(saved));
    fixture.dependencies.signal = new AbortController().signal;
    const result = await fixture.run();
    assert.equal(result.summary.outcome, "failed", field);
    assert.match(
      result.summary.reasons.join(" "),
      /unable to recover.*CI repair/u,
      field,
    );
  }
  assert.equal(fixture.state.submissions.length, submissions);
  assert.equal(fixture.publicationState.pushes, 1);
});
