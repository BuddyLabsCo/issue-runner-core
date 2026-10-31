/* eslint-disable @typescript-eslint/require-await -- Scripted external boundaries. */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { appendFileSync } from "node:fs";
import {
  access,
  appendFile,
  mkdir,
  readFile,
  readdir,
  writeFile,
} from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { executeCli } from "../../src/cli.ts";
import {
  implementationCommand,
  implementationRun,
  publish,
} from "../support/implementation-run.ts";
import { validConfig } from "../support/cli-project.ts";
import {
  documentCommand,
  documentationRun,
} from "../support/documentation-run.ts";

await test("the recovery hash uses the configuration bytes validated at startup", async (t) => {
  const fixture = await implementationRun(t);
  const file = path.join(fixture.directory, "config.yaml");
  const config = await readFile(file);
  const write = fixture.dependencies.operator.write.bind(
    fixture.dependencies.operator,
  );
  fixture.dependencies.operator.write = (message) => {
    write(message);
    if (message === "demo: workflow sessionid=n/a")
      appendFileSync(file, "\n# Edited after validation\n");
  };
  assert.equal((await fixture.run()).summary.outcome, "incomplete");
  const expectedHash = createHash("sha256")
    .update(JSON.stringify(implementationCommand))
    .update(config)
    .digest("hex");
  assert.equal((await fixture.snapshot()).input_hash, expectedHash);
});

await test("an execution checkpoint from another input scope cannot resume or overwrite retained work", async (t) => {
  const fixture = await implementationRun(t);
  assert.equal((await fixture.run()).summary.outcome, "incomplete");
  const saved = await fixture.snapshot();
  const recovery = path.join(fixture.directory, "recovery");
  const file = path.join(recovery, (await readdir(recovery))[0]!);
  const submissions = fixture.state.submissions.length;
  for (const patch of [
    { input_hash: "another-input" },
    { run_arguments: ["run", "--project", "demo", "--document"] },
    { project: "another-project" },
    { purpose: "documentation" },
  ]) {
    const text = JSON.stringify({ ...saved, ...patch });
    await writeFile(file, text);
    const result = await fixture.run();
    assert.equal(result.summary.outcome, "failed", JSON.stringify(result));
    assert.match(result.summary.reasons.join("; "), /unable to recover/u);
    assert.equal(await readFile(file, "utf8"), text);
    assert.equal(fixture.state.submissions.length, submissions);
    assert.deepEqual(fixture.state.cleanup, []);
  }
});

for (const change of ["arguments", "configuration"] as const) {
  await test(`changed ${change} ignore old counts and preserve ambiguous retained work`, async (t) => {
    const fixture = await implementationRun(t, {
      ...validConfig,
      agentRetry: 1,
    });
    fixture.state.onTask = (file) => publish(file, {});
    fixture.state.onCorrection = (file) => publish(file, {});
    fixture.state.onSleep = async (ms) => {
      if (ms === 250) fixture.controller.abort();
    };
    assert.equal((await fixture.run()).summary.outcome, "cancelled");
    const saved = await fixture.snapshot();
    assert.equal(saved.corrections, 1);
    const recovery = path.join(fixture.directory, "recovery");
    const oldFile = path.join(recovery, (await readdir(recovery))[0]!);
    const oldText = await readFile(oldFile, "utf8");
    const command = [...implementationCommand];
    if (change === "arguments") command[4] = "alternate";
    else
      await appendFile(
        path.join(fixture.directory, "config.yaml"),
        "\n# Changed configuration bytes\n",
      );
    const controller = new AbortController();
    fixture.dependencies.signal = controller.signal;
    const before = fixture.state.submissions.length;
    const reserved = await executeCli(command, fixture.dependencies);
    assert.equal(reserved.summary.outcome, "incomplete");
    assert.match(reserved.summary.reasons.join("; "), /existing Reservation/u);
    assert.equal(fixture.state.submissions.length, before);
    assert.deepEqual(fixture.dependencies.pauses, []);

    // Simulate the operator releasing the prior Reservation before new work.
    fixture.state.ticket.labels = ["ready-for-agent"];
    fixture.state.ticket.assignees = [];
    fixture.state.onSleep = async (ms) => {
      assert.ok(ms > 0);
    };
    const submitted: string[] = [];
    fixture.dependencies.terminalPlugin.submitText = async (_tab, text) => {
      submitted.push(text);
      if (text.startsWith("Session Probe\n")) controller.abort();
    };
    assert.equal(
      (await executeCli(command, fixture.dependencies)).summary.outcome,
      "cancelled",
    );
    const newFile = (await readdir(recovery)).find(
      (name) => path.join(recovery, name) !== oldFile,
    )!;
    const current = JSON.parse(
      await readFile(path.join(recovery, newFile), "utf8"),
    ) as typeof saved;
    assert.notEqual(current.run_id, saved.run_id);
    assert.notEqual(current.execution_id, saved.execution_id);
    assert.notEqual(current.worktree, saved.worktree);
    assert.notEqual(current.input_hash, saved.input_hash);
    assert.deepEqual(current.run_arguments, command);
    assert.equal(current.corrections, 0);
    assert.deepEqual(current.roles, {});
    assert.equal(submitted[0], validConfig.agents.implement.start);
    assert.equal(await readFile(oldFile, "utf8"), oldText);
    await access(saved.worktree);
    await access(saved.probe!.path);
    await access(saved.invocation!.path);
    assert.deepEqual(fixture.state.cleanup, []);
  });
}

await test("a failed atomic checkpoint write preserves the last valid invocation without serializing tab handles", async (t) => {
  const fixture = await implementationRun(t);
  const createTab = fixture.dependencies.terminalPlugin.createTab.bind(
    fixture.dependencies.terminalPlugin,
  );
  fixture.dependencies.terminalPlugin.createTab = async (options) => ({
    ...(await createTab(options)),
    toJSON() {
      assert.fail("opaque tab handles must never be serialized");
    },
  });
  fixture.state.onTask = async () => {
    fixture.controller.abort();
  };
  assert.equal((await fixture.run()).summary.outcome, "cancelled");
  const saved = await fixture.snapshot();
  const recovery = path.join(fixture.directory, "recovery");
  const file = path.join(recovery, (await readdir(recovery))[0]!);
  const text = await readFile(file, "utf8");
  await publish(saved.invocation!.path, {});
  await mkdir(`${file}.tmp`);
  fixture.dependencies.signal = new AbortController().signal;
  fixture.state.onSleep = async (ms) => {
    assert.ok(ms > 0);
  };
  fixture.dependencies.operator.pause = async (message) => {
    assert.match(message, /Operation failed/u);
    assert.ok(message.includes(`${file}.tmp`));
    return "q";
  };
  const result = await fixture.run();
  assert.equal(result.summary.outcome, "cancelled", JSON.stringify(result));
  assert.equal(await readFile(file, "utf8"), text);
  assert.equal(fixture.state.taskCount, 1);
  await access(saved.worktree);
  await access(saved.invocation!.path);
});

await test("standalone documentation retains Run arguments on its occurrence and execution", async (t) => {
  const fixture = await documentationRun(t);
  fixture.state.onTask = async () => {
    fixture.controller.abort();
  };
  assert.equal((await fixture.run()).summary.outcome, "cancelled");
  const recovery = path.join(fixture.directory, "recovery");
  for (const name of await readdir(recovery)) {
    const file = path.join(recovery, name);
    const saved = JSON.parse(await readFile(file, "utf8")) as Record<
      string,
      unknown
    >;
    assert.deepEqual(saved.run_arguments, documentCommand);
    assert.equal(saved.input_hash, name.split("-")[0]);
  }
  const name = (await readdir(recovery)).find((name) =>
    name.endsWith("-document.json"),
  )!;
  const file = path.join(recovery, name);
  const saved = JSON.parse(await readFile(file, "utf8")) as object;
  const text = JSON.stringify({
    ...saved,
    run_arguments: implementationCommand,
  });
  await writeFile(file, text);
  fixture.dependencies.signal = new AbortController().signal;
  fixture.dependencies.operator.pause = async (message) => {
    assert.match(message, /restart the entire Documentation Maintenance/u);
    return "q";
  };
  assert.equal((await fixture.run()).summary.outcome, "cancelled");
  assert.equal(fixture.maintenance.creates, 1);
  assert.equal(fixture.state.taskCount, 1);
  assert.equal(await readFile(file, "utf8"), text);
});
