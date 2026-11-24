/* eslint-disable @typescript-eslint/require-await -- Scripted external boundaries. */
import assert from "node:assert/strict";
import test from "node:test";
import {
  committed,
  implementationRun,
  publish,
} from "../support/implementation-run.ts";
import { validConfig } from "../support/cli-project.ts";

await test("base startup checkpoints an execute reference after the startup delay without a Probe", async (t) => {
  const fixture = await implementationRun(t, {
    ...validConfig,
    terminalPlugins: { agentStartDelay: 0.125 },
  });
  const reference = "  native/$&/$`/$'/startup  ";
  const order: string[] = [];
  fixture.dependencies.terminalPlugin.execute = async (_tab, command) => {
    assert.equal(command, validConfig.agents.implement.start);
    order.push("command");
    return reference;
  };
  fixture.state.onSleep = async (ms) => {
    order.push(`sleep:${ms}`);
  };
  fixture.state.onTask = async (file) => {
    order.push("task");
    const saved = await fixture.snapshot();
    assert.equal(saved.roles.implement?.sessionid, reference);
    assert.equal(saved.probe, undefined);
    fixture.state.evidence.commits = committed().commits;
    await publish(file, committed());
  };
  const result = await fixture.run();
  assert.match(result.summary.tickets![0]!.detail, /CI-ready/u);
  assert.deepEqual(order.slice(0, 3), ["command", "sleep:125", "task"]);
  assert.equal(fixture.state.probeCount, 0);
  const saved = await fixture.snapshot();
  assert.equal(saved.roles.implement?.sessionid, reference);
  assert.equal(saved.probe, undefined);
});

await test("base startup without an execute reference still uses a Probe", async (t) => {
  const fixture = await implementationRun(t);
  fixture.dependencies.terminalPlugin.execute = async () => undefined;
  fixture.state.onProbe = async (assignment) => {
    await publish(String(assignment.path), { sessionid: "probe-derived" });
  };
  fixture.state.onTask = async (file) => {
    assert.equal(
      (await fixture.snapshot()).roles.implement?.sessionid,
      "probe-derived",
    );
    fixture.state.evidence.commits = committed().commits;
    await publish(file, committed());
  };
  const result = await fixture.run();
  assert.match(result.summary.tickets![0]!.detail, /CI-ready/u);
  assert.equal(fixture.state.probeCount, 1);
  assert.equal(fixture.state.taskCount, 1);
});

await test("resume accepts a matching execute reference without a fresh Probe", async (t) => {
  const fixture = await implementationRun(t);
  const reference = "native/resume/reference";
  fixture.dependencies.terminalPlugin.execute = async (_tab, command) => {
    assert.equal(command, validConfig.agents.implement.start);
    return reference;
  };
  fixture.state.onTask = async () => {
    fixture.controller.abort();
  };
  assert.equal((await fixture.run()).summary.outcome, "cancelled");
  const saved = await fixture.snapshot();
  assert.equal(saved.roles.implement?.sessionid, reference);
  assert.equal(saved.probe, undefined);

  const controller = new AbortController();
  const commands: string[] = [];
  const submit = fixture.dependencies.terminalPlugin.onInput.bind(
    fixture.dependencies.terminalPlugin,
  );
  fixture.dependencies.signal = controller.signal;
  fixture.dependencies.terminalPlugin.execute = async (_tab, command) => {
    commands.push(command);
    return reference;
  };
  fixture.dependencies.terminalPlugin.onInput = async (tab, text, chord) => {
    await submit(tab, text, chord);
    if (text === "continue") {
      fixture.state.evidence.commits = committed().commits;
      await publish(saved.invocation!.path, committed());
    }
  };
  const before = fixture.state.submissions.length;
  const result = await fixture.run();
  assert.match(result.summary.tickets![0]!.detail, /CI-ready/u);
  assert.deepEqual(commands, [`any-cli --resume "${reference}"`]);
  assert.deepEqual(
    fixture.state.submissions.slice(before).map(({ text }) => text),
    ["continue"],
  );
  assert.equal(fixture.state.probeCount, 0);
  assert.equal(
    (await fixture.snapshot()).roles.implement?.sessionid,
    reference,
  );
});

await test("resume rejects a mismatched execute reference before submitting work", async (t) => {
  const fixture = await implementationRun(t);
  const reference = "native/resume/reference";
  fixture.dependencies.terminalPlugin.execute = async (_tab, command) => {
    assert.equal(command, validConfig.agents.implement.start);
    return reference;
  };
  fixture.state.onTask = async () => {
    fixture.controller.abort();
  };
  assert.equal((await fixture.run()).summary.outcome, "cancelled");
  const saved = await fixture.snapshot();

  const controller = new AbortController();
  const commands: string[] = [];
  let dispatched = 0;
  fixture.dependencies.signal = controller.signal;
  fixture.dependencies.terminalPlugin.execute = async (_tab, command) => {
    commands.push(command);
    return "different-native";
  };
  fixture.dependencies.terminalPlugin.onInput = async () => {
    dispatched += 1;
    controller.abort();
  };
  const result = await fixture.run();
  assert.equal(result.summary.outcome, "failed");
  assert.match(result.summary.failure!, /Invalid native session identity/u);
  assert.deepEqual(commands, [`any-cli --resume "${reference}"`]);
  assert.equal(dispatched, 0);
  assert.equal(fixture.state.probeCount, 0);
  assert.equal(
    (await fixture.snapshot()).roles.implement?.sessionid,
    reference,
  );
  assert.equal(
    (await fixture.snapshot()).invocation?.path,
    saved.invocation!.path,
  );
});

await test("base startup rejects an invalid execute reference before probing or dispatch", async (t) => {
  const fixture = await implementationRun(t);
  fixture.dependencies.terminalPlugin.execute = async () => "latest";
  const result = await fixture.run();
  assert.equal(result.summary.outcome, "failed");
  assert.match(result.summary.failure!, /Invalid native session identity/u);
  assert.equal(fixture.state.probeCount, 0);
  assert.equal(fixture.state.taskCount, 0);
  assert.equal((await fixture.snapshot()).roles.implement, undefined);
});
