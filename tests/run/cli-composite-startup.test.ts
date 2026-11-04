/* eslint-disable @typescript-eslint/require-await -- Scripted external boundaries. */
import assert from "node:assert/strict";
import test from "node:test";
import { setImmediate } from "node:timers/promises";
import { access } from "node:fs/promises";
import path from "node:path";
import { executeCli } from "../../src/cli.ts";
import {
  implementationRun,
  implementationCommand,
  committed,
  deferred,
  publish,
} from "../support/implementation-run.ts";
import { documentationRun } from "../support/documentation-run.ts";
import { findings, reviewRun } from "../support/review-run.ts";
import { ciRepairRun } from "../support/ci-repair-run.ts";
import { validConfig } from "../support/cli-project.ts";

for (const agentStartDelay of [undefined, 0, 0.125]) {
  await test(`base startup waits ${agentStartDelay ?? 10} seconds before Probe and business dispatch`, async (t) => {
    const fixture = await implementationRun(t, {
      ...validConfig,
      terminalPlugins: agentStartDelay === undefined ? {} : { agentStartDelay },
    });
    const order: string[] = [];
    const execute = fixture.dependencies.terminalPlugin.execute.bind(
      fixture.dependencies.terminalPlugin,
    );
    fixture.dependencies.terminalPlugin.execute = async (tab, command) => {
      assert.equal(command, 'any-cli --model "my model" --native-option');
      assert.equal("agent" in fixture.state.tabOptions[0]!, false);
      order.push("command");
      await execute(tab, command);
    };
    fixture.state.onSleep = async (ms) => {
      order.push(`sleep:${ms}`);
    };
    fixture.state.onProbe = async (assignment) => {
      order.push("probe");
      await publish(String(assignment.path), { sessionid: "opaque/$&/native" });
    };
    fixture.state.onTask = async (file) => {
      order.push("task");
      assert.equal(
        (await fixture.snapshot()).roles.implement?.sessionid,
        "opaque/$&/native",
      );
      fixture.state.evidence.commits = committed().commits;
      await publish(file, {
        ...committed(),
        pr_title: "fix: business title",
        pr_body: "Business body. Closes #50",
      });
    };
    assert.match((await fixture.run()).summary.reasons.join(" "), /CI-ready/);
    assert.deepEqual(order.slice(0, 4), [
      "command",
      `sleep:${(agentStartDelay ?? 10) * 1000}`,
      "probe",
      "task",
    ]);
    assert.equal(
      (await fixture.snapshot()).publication?.title,
      "fix: business title",
    );
  });
}

await test("continuing after uncertain command delivery reuses the tab without launching twice", async (t) => {
  const fixture = await implementationRun(t);
  let launches = 0;
  fixture.dependencies.terminalPlugin.execute = async () => {
    launches++;
    throw new Error("transport interrupted after command submission");
  };
  fixture.dependencies.operator.pause = async (message) => {
    assert.match(message, /delivery is uncertain.*will not be replayed/);
    assert.match(message, /s to skip Issue #50/);
    fixture.dependencies.pauses.push(message);
    return "";
  };
  assert.match((await fixture.run()).summary.reasons.join(" "), /CI-ready/);
  assert.equal(launches, 1);
  assert.equal(fixture.state.tabOptions.length, 1);
  assert.equal(fixture.dependencies.pauses.length, 1);
  assert.equal(fixture.state.probeCount, 1);
});

await test("pending command input can exceed the operation bound without dispatch", async (t) => {
  const fixture = await implementationRun(t);
  const entered = deferred<void>();
  const submitted = deferred<void>();
  fixture.dependencies.terminalPlugin.execute = async () => {
    entered.resolve();
    return submitted.promise;
  };
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const running = fixture.run();
  await entered.promise;
  t.mock.timers.tick(120_000);
  await setImmediate();
  assert.equal(fixture.state.taskCount, 0);
  assert.equal(fixture.state.probeCount, 0);
  assert.deepEqual(fixture.state.sleeps, []);
  assert.deepEqual(fixture.dependencies.pauses, []);
  submitted.resolve();
  assert.match((await running).summary.reasons.join(" "), /CI-ready/);
});

for (const choice of ["s", "q", null]) {
  await test(`startup failure retains the tab when the operator selects ${choice ?? "EOF"}`, async (t) => {
    const fixture = await implementationRun(t);
    fixture.dependencies.terminalPlugin.execute = async () => {
      throw new Error("command failed");
    };
    fixture.dependencies.operator.pause = async () => choice;
    const result = await fixture.run();
    assert.equal(
      result.summary.outcome,
      choice === "s" ? "incomplete" : "cancelled",
    );
    assert.equal(fixture.state.tabOptions.length, 1);
    assert.deepEqual(fixture.state.closedTabs, []);
    assert.equal(fixture.state.taskCount, 0);
  });
}

for (const phase of ["command", "delay"] as const) {
  await test(`cancellation during base ${phase} retains the tab and prevents Probe`, async (t) => {
    const fixture = await implementationRun(t);
    const entered = deferred<void>();
    const pending = async () => {
      entered.resolve();
      return new Promise<void>(() => {
        /* Transport deliberately remains pending. */
      });
    };
    if (phase === "command")
      fixture.dependencies.terminalPlugin.execute = pending;
    else fixture.state.onSleep = pending;
    const running = fixture.run();
    await entered.promise;
    fixture.controller.abort();
    assert.equal((await running).summary.outcome, "cancelled");
    assert.equal(fixture.state.tabOptions[0]!.signal?.aborted, true);
    assert.equal(fixture.state.probeCount, 0);
    assert.equal(fixture.state.taskCount, 0);
    assert.deepEqual(fixture.state.closedTabs, []);
    for (const file of fixture.state.gitConfigs)
      await assert.rejects(access(file));
  });
}

for (const identity of [
  "",
  "  ",
  "latest",
  "last",
  "run_id",
  "execution_id",
  null,
  42,
]) {
  await test(`invalid Probe identity ${String(identity)} cannot dispatch business work`, async (t) => {
    const fixture = await implementationRun(t);
    fixture.state.onProbe = async (assignment) => {
      if (fixture.state.probeCount === 2) {
        fixture.controller.abort();
        return;
      }
      await publish(String(assignment.path), {
        sessionid:
          identity === "run_id" || identity === "execution_id"
            ? (await fixture.snapshot())[identity]
            : identity,
      });
    };
    assert.equal((await fixture.run()).summary.outcome, "cancelled");
    assert.equal(fixture.state.taskCount, 0);
    assert.equal((await fixture.snapshot()).roles.implement, undefined);
    assert.match(
      fixture.dependencies.messages.join(" "),
      /Probe requires actual native identity/,
    );
    assert.deepEqual(fixture.state.closedTabs, []);
  });
}

await test("an interrupted execution resumes its exact opaque native ref before accepting PR metadata", async (t) => {
  const fixture = await implementationRun(t);
  const native = "  opaque/$&/$`/$'/native  ";
  fixture.state.onProbe = async (assignment) =>
    publish(String(assignment.path), { sessionid: native });
  fixture.state.onTask = async () => fixture.controller.abort();
  assert.equal((await fixture.run()).summary.outcome, "cancelled");
  const saved = await fixture.snapshot();
  assert.equal(saved.pr_title, undefined);
  let resumes = 0;
  fixture.dependencies.terminalPlugin.execute = async (_tab, command) => {
    assert.equal(command, `any-cli --resume "${native}"`);
    resumes++;
  };
  fixture.dependencies.terminalPlugin.onInput = async (_tab, text) => {
    assert.equal(text, "continue");
    fixture.state.evidence.commits = committed().commits;
    await publish(saved.invocation!.path, committed());
  };
  const result = await executeCli(implementationCommand, {
    ...fixture.dependencies,
    signal: new AbortController().signal,
  });
  assert.match(result.summary.reasons.join(" "), /CI-ready/);
  assert.equal(resumes, 1);
  assert.equal(fixture.state.probeCount, 1);
  assert.equal(fixture.state.taskCount, 1);
  assert.equal(
    (await fixture.snapshot()).publication?.title,
    committed().pr_title,
  );
});

await test("an identity checkpoint can resume before the first business assignment exists", async (t) => {
  const fixture = await implementationRun(t);
  fixture.state.onTask = async () => fixture.controller.abort();
  assert.equal((await fixture.run()).summary.outcome, "cancelled");
  const saved = await fixture.snapshot();
  await publish(
    path.join(fixture.directory, "recovery", `${saved.input_hash}-50.json`),
    {
      ...saved,
      phase: "worktree_created",
      invocation: undefined,
      pendingPrompt: undefined,
    },
  );
  fixture.dependencies.terminalPlugin.execute = async (_tab, command) => {
    assert.equal(
      command,
      `any-cli --resume "${saved.roles.implement!.sessionid}"`,
    );
  };
  fixture.state.onTask = async (file) => {
    fixture.state.evidence.commits = committed().commits;
    await publish(file, committed());
  };
  const result = await executeCli(implementationCommand, {
    ...fixture.dependencies,
    signal: new AbortController().signal,
  });
  assert.match(result.summary.reasons.join(" "), /CI-ready/);
  assert.equal((await fixture.snapshot()).execution_id, saved.execution_id);
  assert.equal(fixture.state.probeCount, 1);
});

await test("documentation establishes Probe identity before publishing business metadata", async (t) => {
  const fixture = await documentationRun(t);
  fixture.state.onProbe = async (assignment) =>
    publish(String(assignment.path), { sessionid: "document-native" });
  fixture.state.onTask = async (file) => {
    assert.equal(
      (await fixture.snapshot()).roles.documentation?.sessionid,
      "document-native",
    );
    fixture.state.evidence.commits = committed().commits;
    await publish(file, {
      ...committed(),
      pr_title: "docs: business title",
      pr_body: "Document body. Closes #50",
    });
  };
  assert.equal(
    (await fixture.run(["--no-auto-merge"])).summary.outcome,
    "incomplete",
  );
  assert.equal(
    (await fixture.snapshot()).publication?.title,
    "docs: business title",
  );
  assert.equal(fixture.state.probeCount, 1);
});

await test("base commands preserve independent implementation and Review roles through a Review fix", async (t) => {
  const fixture = await reviewRun(t, 1);
  fixture.reviewState.onReview = findings;
  assert.match((await fixture.run()).summary.reasons.join(" "), /CI-ready/);
  const saved = await fixture.snapshot();
  assert.notEqual(
    saved.roles.implement?.sessionid,
    saved.roles.review?.sessionid,
  );
  assert.equal(fixture.state.probeCount, 2);
  assert.equal(fixture.reviewState.fixes.length, 1);
  assert.equal(
    fixture.state.submissions.filter(
      ({ text }) =>
        text === `any-cli --resume "${saved.roles.implement!.sessionid}"`,
    ).length,
    1,
  );
});

await test("base repair identity persists independently of the implementation role", async (t) => {
  const fixture = await ciRepairRun(t);
  const task = fixture.repairs.onTask;
  fixture.repairs.onTask = async (file, evidence) => {
    const saved = await fixture.snapshot();
    assert.notEqual(
      saved.roles.implement?.sessionid,
      saved.publication?.ciRepair?.attempts.at(-1)?.sessionid,
    );
    assert.equal(
      saved.publication?.ciRepair?.attempts.at(-1)?.sessionid,
      "ci-session-1",
    );
    await task(file, evidence);
  };
  assert.match((await fixture.run()).summary.reasons.join(" "), /CI-ready/);
  assert.equal(fixture.state.probeCount, 1);
  assert.equal(fixture.repairs.probes.length, 1);
});
