/* eslint-disable @typescript-eslint/require-await -- Scripted external boundaries. */
import assert from "node:assert/strict";
import { access, readFile, readdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { child, parentRun } from "../support/parent-run.ts";
import { conflictRepairRun } from "../support/conflict-repair-run.ts";
import { validConfig } from "../support/cli-project.ts";
import { stringify } from "yaml";
import { executeCli } from "../../src/cli.ts";
import {
  implementationCommand,
  implementationRun,
  implementationProgress,
  publish,
  committed,
} from "../support/implementation-run.ts";

await test("explicit whole-Issue restart retains failed resources and resets only the new execution", async (t) => {
  const fixture = await implementationRun(t);
  fixture.state.onTask = (file) => publish(file, {});
  fixture.state.onCorrection = async () => fixture.controller.abort();
  assert.equal((await fixture.run()).summary.outcome, "cancelled");
  const saved = await fixture.snapshot();
  assert.ok(saved.corrections > 0);
  const recovery = path.join(fixture.directory, "recovery");
  const file = path.join(recovery, `${saved.input_hash}-50.json`);
  // A missing required native role is an established recovery failure.
  await publish(saved.invocation!.path, {});
  const failed = { ...saved, roles: {} };
  await publish(file, failed);
  const retainedText = await readFile(file, "utf8");
  fixture.dependencies.signal = new AbortController().signal;
  let pauses = 0;
  fixture.dependencies.operator.pause = async (message) => {
    assert.equal(
      message,
      "Enter to restart the entire Issue #50, or q to exit Runner.",
    );
    pauses += 1;
    return "";
  };
  fixture.state.onProbe = async (assignment) => {
    await publish(String(assignment.path), {
      ...assignment,
      sessionid: "new-native-context",
      pr_title: "fix: [issue-50] restart the Issue",
      pr_body: "New execution metadata.\n\nCloses #50",
    });
  };
  fixture.state.onTask = async (output) => {
    const fresh = await fixture.snapshot();
    assert.equal(fresh.publication, undefined);
    assert.equal(fresh.reviews, undefined);
    fixture.state.evidence.commits = committed().commits;
    await publish(output, committed());
  };
  const before = fixture.state.submissions.length;
  const result = await executeCli(implementationCommand, fixture.dependencies);
  assert.equal(result.summary.outcome, "incomplete", JSON.stringify(result));
  assert.equal(pauses, 1);
  assert.equal(
    fixture.dependencies.messages.filter(
      (message) => message === "unable to recover",
    ).length,
    1,
  );
  const current = await fixture.snapshot();
  for (const key of [
    "execution_id",
    "worktree",
    "branch",
    "probe",
    "invocation",
  ] as const)
    assert.notDeepEqual(current[key], saved[key]);
  assert.equal(current.phase, "implementation_completed");
  assert.equal(current.corrections, 0);
  assert.equal(current.probeRetries, 0);
  assert.deepEqual(current.superseded, []);
  assert.equal(current.reviews, undefined);
  assert.equal(current.roles.implement?.sessionid, "new-native-context");
  assert.equal(current.pr_title, "fix: [issue-50] restart the Issue");
  assert.equal(current.pr_body, "New execution metadata.\n\nCloses #50");
  assert.equal(fixture.state.probeCount, 2);
  assert.equal(fixture.state.taskCount, 2);
  assert.equal(
    fixture.state.submissions[before]?.text,
    validConfig.agents.implement.start,
  );
  const archive = (await readdir(recovery)).find((name) =>
    name.endsWith(".retained"),
  )!;
  assert.equal(
    await readFile(path.join(recovery, archive), "utf8"),
    retainedText,
  );
  for (const resource of [
    saved.worktree,
    saved.probe!.path,
    saved.invocation!.path,
  ])
    await access(resource);
  assert.deepEqual(fixture.state.cleanup, []);
});

await test("an explicit native resume failure offers restart or exit without inferring Agent liveness", async (t) => {
  const fixture = await implementationRun(t);
  fixture.state.onTask = async () => fixture.controller.abort();
  assert.equal((await fixture.run()).summary.outcome, "cancelled");
  const saved = await fixture.snapshot();
  fixture.dependencies.signal = new AbortController().signal;
  let pauses = 0;
  fixture.dependencies.operator.pause = async (message) => {
    assert.equal(
      message,
      "Enter to restart the entire Issue #50, or q to exit Runner.",
    );
    pauses += 1;
    return "q";
  };
  const submit = fixture.dependencies.terminalPlugin.submitText.bind(
    fixture.dependencies.terminalPlugin,
  );
  fixture.dependencies.terminalPlugin.submitText = async (tab, text, chord) => {
    if (text.startsWith("any-cli --resume"))
      throw new Error("native context unavailable");
    await submit(tab, text, chord);
  };
  const result = await fixture.run();
  assert.equal(result.summary.outcome, "cancelled", JSON.stringify(result));
  assert.equal(pauses, 1);
  assert.ok(fixture.dependencies.messages.includes("unable to recover"));
  assert.deepEqual(await fixture.snapshot(), saved);
  assert.equal(fixture.state.probeCount, 1);
  assert.equal(fixture.state.taskCount, 1);
  assert.deepEqual(fixture.state.cleanup, []);
});

await test("a missing retained conflict repair Worktree offers exit even during deferred integration", async (t) => {
  const fixture = await conflictRepairRun(t);
  await writeFile(
    path.join(fixture.directory, "config.yaml"),
    stringify({ ...validConfig, workflow: { review: false }, issueList: [50] }),
  );
  const run = () =>
    executeCli(
      ["run", "--project", "demo", "--env", "fake", "--issue"],
      fixture.dependencies,
    );
  fixture.repairs.onTask = async () => fixture.controller.abort();
  assert.equal((await run()).summary.outcome, "cancelled");
  const saved = await fixture.snapshot();
  await rm(saved.publication!.conflictRepair!.attempts[0]!.worktree, {
    recursive: true,
  });
  fixture.dependencies.signal = new AbortController().signal;
  let pauses = 0;
  fixture.dependencies.operator.pause = async (message) => {
    assert.equal(
      message,
      "Enter to restart the entire Issue #50, or q to exit Runner.",
    );
    pauses += 1;
    return "q";
  };
  assert.equal((await run()).summary.outcome, "cancelled");
  assert.equal(pauses, 1);
  assert.deepEqual(await fixture.snapshot(), saved);
  assert.equal(fixture.state.taskCount, 1);
});

await test("restarting one Issue preserves another Issue's completed progress and consumed counts", async (t) => {
  const fixture = await parentRun(t, [child(51), child(52)], {
    ...validConfig,
    issueList: [51, 52],
  });
  const run = () => fixture.run(["--issue"]);
  const result = await run();
  assert.equal(result.summary.outcome, "incomplete", JSON.stringify(result));
  const old = await implementationProgress(fixture.directory, 51);
  const other = await implementationProgress(fixture.directory, 52);
  other.corrections = 2;
  other.probeRetries = 1;
  const recovery = path.join(fixture.directory, "recovery");
  await publish(path.join(recovery, `${old.input_hash}-51.json`), {
    ...old,
    roles: {},
  });
  await publish(path.join(recovery, `${other.input_hash}-52.json`), other);
  fixture.dependencies.operator.pause = async (message) => {
    if (message.startsWith("Operation failed:")) return "s";
    assert.equal(
      message,
      "Enter to restart the entire Issue #51, or q to exit Runner.",
    );
    return "";
  };
  const restarted = await run();
  assert.equal(
    restarted.summary.outcome,
    "incomplete",
    JSON.stringify(restarted),
  );
  assert.deepEqual(await implementationProgress(fixture.directory, 52), other);
  const current = await implementationProgress(fixture.directory, 51);
  assert.notEqual(current.execution_id, old.execution_id);
  assert.equal(current.corrections, 0);
  assert.deepEqual([...fixture.dispatched].sort(), [51, 51, 52]);
  // Subsequent matching recovery restores both executions without a new restart.
  assert.equal((await run()).summary.outcome, "incomplete");
  assert.equal(
    (await implementationProgress(fixture.directory, 51)).execution_id,
    current.execution_id,
  );
  assert.deepEqual(await implementationProgress(fixture.directory, 52), other);
  assert.deepEqual([...fixture.dispatched].sort(), [51, 51, 52]);
});

for (const stop of ["EOF", "cancellation"] as const) {
  await test(`${stop} at the recovery choice retains the failed execution without restarting`, async (t) => {
    const fixture = await implementationRun(t);
    fixture.state.onTask = async () => fixture.controller.abort();
    assert.equal((await fixture.run()).summary.outcome, "cancelled");
    const saved = await fixture.snapshot();
    const recovery = path.join(fixture.directory, "recovery");
    const file = path.join(recovery, `${saved.input_hash}-50.json`);
    const invalid = "{incomplete checkpoint";
    await writeFile(file, invalid);
    const controller = new AbortController();
    fixture.dependencies.signal = controller.signal;
    fixture.dependencies.operator.pause = async (message) => {
      assert.equal(
        message,
        "Enter to restart the entire Issue #50, or q to exit Runner.",
      );
      if (stop === "cancellation") controller.abort();
      return stop === "EOF" ? null : "";
    };
    assert.equal((await fixture.run()).summary.outcome, "cancelled");
    assert.ok(fixture.dependencies.messages.includes("unable to recover"));
    assert.equal(await readFile(file, "utf8"), invalid);
    assert.equal(
      (await readdir(recovery)).some((name) => name.endsWith(".retained")),
      false,
    );
    assert.equal(fixture.state.taskCount, 1);
    assert.equal(fixture.state.probeCount, 1);
    assert.deepEqual(fixture.state.cleanup, []);
    await access(saved.worktree);
  });
}

for (const interruptedAt of ["inspection", "base fetch"] as const) {
  await test(`cancellation during replacement ${interruptedAt} preserves matching-input recovery`, async (t) => {
    const fixture = await implementationRun(t);
    fixture.state.onTask = async () => fixture.controller.abort();
    assert.equal((await fixture.run()).summary.outcome, "cancelled");
    const saved = await fixture.snapshot();
    const file = path.join(
      fixture.directory,
      "recovery",
      `${saved.input_hash}-50.json`,
    );
    await publish(file, { ...saved, roles: {} });
    const failed = await readFile(file, "utf8");
    const controller = new AbortController();
    fixture.dependencies.signal = controller.signal;
    let restarting = false;
    fixture.dependencies.operator.pause = async (message) => {
      assert.equal(
        message,
        "Enter to restart the entire Issue #50, or q to exit Runner.",
      );
      restarting = true;
      return "";
    };
    const inspect = fixture.dependencies.tracker.getTicket.bind(
      fixture.dependencies.tracker,
    );
    fixture.dependencies.tracker.getTicket = async () => {
      if (restarting && interruptedAt === "inspection") controller.abort();
      return inspect();
    };
    const fetch = fixture.dependencies.gitWorkspace.fetchTargetBranch.bind(
      fixture.dependencies.gitWorkspace,
    );
    fixture.dependencies.gitWorkspace.fetchTargetBranch = async () => {
      if (interruptedAt === "base fetch") controller.abort();
      return fetch();
    };
    assert.equal((await fixture.run()).summary.outcome, "cancelled");
    assert.equal(await readFile(file, "utf8"), failed);
    await access(saved.worktree);
    assert.equal(fixture.state.taskCount, 1);
    fixture.dependencies.signal = new AbortController().signal;
    fixture.dependencies.tracker.getTicket = inspect;
    fixture.dependencies.gitWorkspace.fetchTargetBranch = fetch;
    fixture.state.onTask = async (output) => {
      fixture.state.evidence.commits = committed().commits;
      await publish(output, committed());
    };
    const result = await fixture.run();
    assert.equal(result.summary.outcome, "incomplete", JSON.stringify(result));
    assert.equal(fixture.state.taskCount, 2);
    assert.notEqual(
      (await fixture.snapshot()).execution_id,
      saved.execution_id,
    );
    assert.deepEqual(fixture.state.cleanup, []);
  });
}
