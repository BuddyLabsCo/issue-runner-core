/* eslint-disable @typescript-eslint/require-await -- Scripted external boundaries. */
import assert from "node:assert/strict";
import { access, appendFile, readdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { documentationRun } from "../support/documentation-run.ts";
import { publish } from "../support/implementation-run.ts";

const noChange = {
  outcome: "no_change",
  summary: "Already current",
  commits: [],
  findings_file: null,
};

await test("cancelled documentation cleanup retries report the retained execution resources", async (t) => {
  const fixture = await documentationRun(t);
  fixture.state.onTask = async (file) => {
    fixture.state.evidence.changed = false;
    await publish(file, noChange);
  };
  fixture.dependencies.gitWorkspace.cleanupWorktree = async () => {
    throw new Error("documentation cleanup unavailable");
  };
  fixture.dependencies.operator.pause = async (message) => {
    assert.match(message, /documentation cleanup unavailable/u);
    return "q";
  };
  for (let run = 0; run < 2; run++) {
    fixture.dependencies.signal = new AbortController().signal;
    fixture.dependencies.messages.length = 0;
    assert.equal((await fixture.run()).summary.outcome, "cancelled");
    const saved = await fixture.snapshot();
    const recovery = path.join(fixture.directory, "recovery");
    const executionFile = (await readdir(recovery)).find((name) =>
      name.endsWith("-document-50.json"),
    )!;
    const report = fixture.dependencies.messages
      .filter((message) => message.startsWith("Retained "))
      .join("\n");
    for (const file of [
      path.join(recovery, executionFile),
      saved.worktree,
      saved.probe!.path,
      saved.invocation!.path,
    ]) {
      await access(file);
      assert.ok(
        report.includes(file),
        `Run ${run + 1} omitted retained path: ${file}`,
      );
    }
    assert.ok(report.includes(saved.execution_id));
    assert.ok(report.includes(saved.branch));
    assert.equal(saved.noChangeClosure, "completed");
  }
  assert.equal(fixture.state.taskCount, 1);
  assert.equal(fixture.state.probeCount, 1);
  assert.equal(fixture.maintenance.creates, 1);
  assert.equal(fixture.integrationState.closures, 1);
});

await test("documentation closure with a lost response is reconciled without duplicate writes", async (t) => {
  const fixture = await documentationRun(t);
  fixture.state.onTask = async (file) => {
    fixture.state.evidence.changed = false;
    await publish(file, noChange);
  };
  fixture.integrationState.onClose = async () => {
    fixture.state.ticket.state = "closed";
    fixture.state.ticket.stateReason = "completed";
    throw new Error("lost closure response");
  };
  assert.equal((await fixture.run()).summary.outcome, "succeeded");
  assert.equal(fixture.integrationState.closures, 1);
  assert.equal(fixture.maintenance.cleanup.length, 1);
});

await test("interrupted no-change closure resumes from confirmed tracker state without another Agent or closure", async (t) => {
  const fixture = await documentationRun(t);
  fixture.state.onTask = async (file) => {
    fixture.state.evidence.changed = false;
    await publish(file, noChange);
  };
  fixture.integrationState.onClose = async () => {
    fixture.state.ticket.state = "closed";
    fixture.state.ticket.stateReason = "completed";
    fixture.controller.abort();
  };
  assert.equal((await fixture.run()).summary.outcome, "cancelled");
  const before = await fixture.snapshot();
  assert.equal(before.noChangeClosure, "pending");
  assert.equal(fixture.maintenance.cleanup.length, 0);
  fixture.dependencies.signal = new AbortController().signal;
  assert.equal((await fixture.run()).summary.outcome, "succeeded");
  assert.equal(fixture.state.taskCount, 1);
  assert.equal(fixture.integrationState.closures, 1);
  assert.equal((await fixture.snapshot()).noChangeClosure, "completed");
  assert.equal(fixture.maintenance.creates, 1);
});

await test("cancelled Maintenance Tickets retain documentation artifacts and earn no completion", async (t) => {
  const fixture = await documentationRun(t);
  fixture.state.onTask = async (file) => {
    fixture.state.evidence.changed = false;
    fixture.state.ticket.state = "closed";
    fixture.state.ticket.stateReason = "not_planned";
    await publish(file, noChange);
  };
  assert.equal((await fixture.run()).summary.outcome, "incomplete");
  assert.equal(fixture.integrationState.closures, 0);
  assert.equal(fixture.maintenance.cleanup.length, 0);
  await access((await fixture.snapshot()).invocation!.path);
});

await test("changed configuration starts separate documentation and retains the interrupted occurrence", async (t) => {
  const fixture = await documentationRun(t);
  const task = fixture.state.onTask;
  fixture.state.onTask = async () => {
    fixture.controller.abort();
  };
  assert.equal((await fixture.run()).summary.outcome, "cancelled");
  const previous = await fixture.snapshot();
  await access(previous.worktree);
  await appendFile(
    path.join(fixture.directory, "config.yaml"),
    "\n# New Run input\n",
  );
  fixture.dependencies.signal = new AbortController().signal;
  fixture.state.onTask = task;
  assert.equal((await fixture.run()).summary.outcome, "succeeded");
  const current = await fixture.snapshot();
  assert.notEqual(current.ticket, previous.ticket);
  assert.notEqual(current.run_id, previous.run_id);
  assert.notEqual(current.worktree, previous.worktree);
  assert.equal(fixture.maintenance.creates, 2);
  await access(previous.worktree);
  assert.deepEqual(fixture.maintenance.cleanup, [current.worktree]);
});

await test("documentation output written while stopped is verified without opening another tab", async (t) => {
  const fixture = await documentationRun(t);
  fixture.state.onTask = async () => {
    fixture.controller.abort();
  };
  assert.equal((await fixture.run()).summary.outcome, "cancelled");
  const previous = await fixture.snapshot();
  fixture.state.evidence.changed = false;
  await publish(previous.invocation!.path, noChange);
  fixture.dependencies.signal = new AbortController().signal;
  fixture.dependencies.terminalPlugin.createTab = async () => {
    assert.fail("existing output must be processed first");
  };
  assert.equal((await fixture.run()).summary.outcome, "succeeded");
  assert.equal(fixture.state.probeCount, 1);
  assert.equal(fixture.state.taskCount, 1);
});

await test("uncertain Maintenance Ticket creation is retained and never automatically repeated or adopted", async (t) => {
  const fixture = await documentationRun(t);
  const create = fixture.dependencies.tracker.createMaintenanceTicket.bind(
    fixture.dependencies.tracker,
  );
  fixture.dependencies.tracker.createMaintenanceTicket = async (...args) => {
    await create(...args);
    throw new Error("lost creation response");
  };
  fixture.dependencies.operator.pause = async (message) => {
    assert.match(message, /lost creation response/u);
    return "q";
  };
  assert.equal((await fixture.run()).summary.outcome, "cancelled");
  assert.equal(fixture.maintenance.creates, 1);
  fixture.dependencies.operator.pause = async (message) => {
    assert.match(message, /creation outcome is uncertain/u);
    return "q";
  };
  assert.equal((await fixture.run()).summary.outcome, "cancelled");
  assert.equal(fixture.maintenance.creates, 1);
  assert.equal(fixture.state.taskCount, 0);
});

await test("unrecoverable documentation offers an explicit whole-occurrence restart and retains old resources", async (t) => {
  const fixture = await documentationRun(t);
  const task = fixture.state.onTask;
  fixture.state.onTask = async () => {
    fixture.controller.abort();
  };
  assert.equal((await fixture.run()).summary.outcome, "cancelled");
  const previous = await fixture.snapshot();
  const recovery = path.join(fixture.directory, "recovery");
  const file = (await readdir(recovery)).find((name) =>
    name.endsWith("-document-50.json"),
  )!;
  await writeFile(
    path.join(recovery, file),
    JSON.stringify({ ...previous, branch: "unrelated-branch" }),
  );
  fixture.dependencies.signal = new AbortController().signal;
  fixture.dependencies.operator.pause = async (message) => {
    assert.match(message, /restart.*Documentation Maintenance/u);
    assert.ok(!message.includes("retry"));
    return "";
  };
  fixture.state.onTask = task;
  const result = await fixture.run();
  assert.equal(result.summary.outcome, "succeeded", JSON.stringify(result));
  assert.ok(fixture.dependencies.messages.includes("unable to recover"));
  assert.equal(fixture.maintenance.creates, 2);
  const current = await fixture.snapshot();
  assert.notEqual(current.execution_id, previous.execution_id);
  assert.notEqual(current.run_id, previous.run_id);
  assert.equal(current.corrections, 0);
  await access(previous.worktree);
  await access(previous.probe!.path);
});

await test("skipping documentation retains that occurrence and the next invocation starts new work", async (t) => {
  const fixture = await documentationRun(t);
  fixture.publicationState.onChecks = async () => {
    throw new Error("checks unavailable");
  };
  fixture.dependencies.operator.pause = async (message) => {
    assert.match(
      message,
      /s to skip the current Documentation Maintenance occurrence/u,
    );
    return "s";
  };
  assert.equal((await fixture.run()).summary.outcome, "incomplete");
  const previous = await fixture.snapshot();
  assert.equal(fixture.maintenance.cleanup.length, 0);
  fixture.state.onTask = async (file) => {
    fixture.state.evidence.changed = false;
    await publish(file, noChange);
  };
  assert.equal((await fixture.run()).summary.outcome, "succeeded");
  assert.equal(fixture.maintenance.creates, 2);
  await access(previous.worktree);
  await access(previous.invocation!.path);
});

await test("a cancelled Maintenance Ticket on recovery reports incomplete without dispatch or cleanup", async (t) => {
  const fixture = await documentationRun(t);
  fixture.state.onTask = async () => {
    fixture.controller.abort();
  };
  assert.equal((await fixture.run()).summary.outcome, "cancelled");
  fixture.state.ticket.state = "closed";
  fixture.state.ticket.stateReason = "not_planned";
  fixture.dependencies.signal = new AbortController().signal;
  const result = await fixture.run();
  assert.equal(result.summary.outcome, "incomplete");
  assert.equal(result.exitCode, 1);
  assert.equal(fixture.state.taskCount, 1);
  assert.equal(fixture.maintenance.cleanup.length, 0);
});

await test("a missing original documentation Worktree offers exit without opening a replacement Agent", async (t) => {
  const fixture = await documentationRun(t);
  fixture.state.onTask = async () => {
    fixture.controller.abort();
  };
  assert.equal((await fixture.run()).summary.outcome, "cancelled");
  const previous = await fixture.snapshot();
  await rm(previous.worktree, { recursive: true });
  fixture.dependencies.signal = new AbortController().signal;
  fixture.dependencies.operator.pause = async (message) => {
    assert.match(message, /restart the entire Documentation Maintenance/u);
    return "q";
  };
  fixture.dependencies.terminalPlugin.createTab = async () => {
    assert.fail("missing context must not start an Agent");
  };
  assert.equal((await fixture.run()).summary.outcome, "cancelled");
  assert.equal(fixture.maintenance.creates, 1);
  assert.equal(fixture.state.taskCount, 1);
});
