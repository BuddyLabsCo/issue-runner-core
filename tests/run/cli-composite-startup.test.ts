/* eslint-disable @typescript-eslint/require-await -- Scripted external boundaries. */
import assert from "node:assert/strict";
import test from "node:test";
import { setImmediate } from "node:timers/promises";
import { executeCli } from "../../src/cli.ts";
import {
  implementationRun,
  implementationCommand,
  committed,
  deferred,
  publish,
} from "../support/implementation-run.ts";
import { documentationRun } from "../support/documentation-run.ts";
import { access } from "node:fs/promises";
import path from "node:path";
import { findings, reviewRun } from "../support/review-run.ts";
import { ciRepairRun } from "../support/ci-repair-run.ts";

await test("returned native identity skips Probe and publishes business handoff metadata", async (t) => {
  const fixture = await implementationRun(t);
  fixture.dependencies.terminalPlugin.start = async (tab, command) => {
    assert.equal(fixture.state.tabOptions.length, 1);
    assert.equal(command, 'any-cli --model "my model" --native-option');
    assert.ok(tab);
    return "opaque/$&/native";
  };
  fixture.state.onProbe = async () =>
    assert.fail("returned identity needs no Probe");
  fixture.state.onTask = async (file) => {
    const saved = await fixture.snapshot();
    assert.equal(saved.roles.implement?.sessionid, "opaque/$&/native");
    assert.equal(saved.pr_title, undefined);
    fixture.state.evidence.commits = committed().commits;
    await publish(file, {
      ...committed(),
      pr_title: "fix: business title",
      pr_body: "Business body. Closes #50",
    });
  };
  const result = await fixture.run();
  assert.match(result.summary.reasons.join(" "), /CI-ready/);
  const saved = await fixture.snapshot();
  assert.equal(saved.probe, undefined);
  assert.equal(saved.publication?.title, "fix: business title");
  assert.equal(saved.publication?.body, "Business body. Closes #50");
  assert.deepEqual(fixture.state.sleeps, [30_000]);
});

await test("readiness retry reuses the created Runner Tab without launching the Agent twice", async (t) => {
  const fixture = await implementationRun(t);
  const launched = new Set<object>();
  const attempts: object[] = [];
  let launches = 0;
  fixture.dependencies.terminalPlugin.start = async (tab) => {
    attempts.push(tab);
    if (!launched.has(tab)) {
      launched.add(tab);
      launches++;
      throw new Error("readiness interrupted after launch");
    }
    return "native-ready";
  };
  fixture.dependencies.operator.pause = async (message) => {
    assert.match(message, /readiness interrupted after launch/);
    assert.match(message, /s to skip Issue #50/);
    fixture.dependencies.pauses.push(message);
    return "";
  };
  assert.match((await fixture.run()).summary.reasons.join(" "), /CI-ready/);
  assert.equal(launches, 1);
  assert.equal(attempts.length, 2);
  assert.equal(attempts[0], attempts[1]);
  assert.equal(fixture.state.tabOptions.length, 1);
  assert.equal(fixture.dependencies.pauses.length, 1);
  assert.equal(fixture.state.probeCount, 0);
});

await test("readiness can exceed the former operation bound without dispatch or timeout", async (t) => {
  const fixture = await implementationRun(t);
  const entered = deferred<void>();
  const ready = deferred<string>();
  fixture.dependencies.terminalPlugin.start = async () => {
    entered.resolve();
    return ready.promise;
  };
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const running = fixture.run();
  await entered.promise;
  t.mock.timers.tick(120_000);
  await setImmediate();
  assert.equal(fixture.state.taskCount, 0);
  assert.deepEqual(fixture.dependencies.pauses, []);
  assert.deepEqual(fixture.state.closedTabs, []);
  ready.resolve("native-ready");
  assert.match((await running).summary.reasons.join(" "), /CI-ready/);
});

for (const choice of ["s", "q", null]) {
  await test(`startup failure preserves the Runner Tab when the operator selects ${choice ?? "EOF"}`, async (t) => {
    const fixture = await implementationRun(t);
    fixture.dependencies.terminalPlugin.start = async () => {
      throw new Error("readiness failed");
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

await test("cancellation reaches pending readiness and retains the Runner Tab and Agent", async (t) => {
  const fixture = await implementationRun(t);
  const entered = deferred<void>();
  let observedSignal: AbortSignal | undefined;
  const create = fixture.dependencies.terminalPlugin.createTab.bind(
    fixture.dependencies.terminalPlugin,
  );
  fixture.dependencies.terminalPlugin.createTab = async (options) => {
    observedSignal = options.signal;
    return create(options);
  };
  fixture.dependencies.terminalPlugin.start = async () => {
    entered.resolve();
    return new Promise(() => {
      /* Readiness remains pending until cancellation. */
    });
  };
  const running = fixture.run();
  await entered.promise;
  fixture.controller.abort();
  assert.equal((await running).summary.outcome, "cancelled");
  assert.equal(observedSignal?.aborted, true);
  assert.equal(fixture.state.tabOptions.length, 1);
  assert.equal(fixture.state.taskCount, 0);
  assert.deepEqual(fixture.state.closedTabs, []);
  for (const file of fixture.state.gitConfigs)
    await assert.rejects(access(file));
});

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
  await test(`invalid returned identity ${String(identity)} never falls back to Probe or dispatches work`, async (t) => {
    const fixture = await implementationRun(t);
    Object.assign(fixture.dependencies.terminalPlugin, {
      start: async () =>
        identity === "run_id" || identity === "execution_id"
          ? (await fixture.snapshot())[identity]
          : identity,
    });
    const result = await fixture.run();
    assert.equal(result.summary.outcome, "failed");
    assert.match(
      result.summary.reasons.join(" "),
      /Invalid native session identity/,
    );
    assert.equal(fixture.state.probeCount, 0);
    assert.equal(fixture.state.taskCount, 0);
    assert.equal((await fixture.snapshot()).roles.implement, undefined);
    assert.deepEqual(fixture.state.closedTabs, []);
  });
}

for (const returned of [undefined, "different-native-ref"]) {
  await test(`resume rejects ${String(returned)} before continuing an interrupted pre-handoff execution`, async (t) => {
    const fixture = await implementationRun(t);
    fixture.dependencies.terminalPlugin.start = async () => "saved/$&/native";
    fixture.state.onTask = async () => fixture.controller.abort();
    assert.equal((await fixture.run()).summary.outcome, "cancelled");
    const saved = await fixture.snapshot();
    assert.equal(saved.pr_title, undefined);
    assert.equal(saved.result, undefined);
    Object.assign(fixture.dependencies.terminalPlugin, {
      resume: async (_tab: object, command: string, ref: string) => {
        assert.equal(command, 'any-cli --resume "saved/$&/native"');
        assert.equal(ref, "saved/$&/native");
        return returned;
      },
    });
    const result = await executeCli(implementationCommand, {
      ...fixture.dependencies,
      signal: new AbortController().signal,
    });
    assert.equal(result.summary.outcome, "failed");
    assert.match(
      result.summary.reasons.join(" "),
      /Invalid native session identity/,
    );
    assert.equal(fixture.state.taskCount, 1);
    assert.equal(fixture.state.probeCount, 0);
    assert.equal(
      (await fixture.snapshot()).roles.implement?.sessionid,
      "saved/$&/native",
    );
  });
}

await test("an interrupted execution resumes its returned opaque ref before accepting its first PR metadata", async (t) => {
  const fixture = await implementationRun(t);
  const native = "  opaque/$&/$`/$'/native  ";
  fixture.dependencies.terminalPlugin.start = async () => native;
  fixture.state.onTask = async () => fixture.controller.abort();
  assert.equal((await fixture.run()).summary.outcome, "cancelled");
  const saved = await fixture.snapshot();
  assert.equal(saved.pr_title, undefined);
  assert.equal(saved.pr_body, undefined);
  let resumes = 0;
  fixture.dependencies.terminalPlugin.resume = async (_tab, command, ref) => {
    assert.equal(ref, native);
    assert.equal(command, `any-cli --resume "${native}"`);
    resumes++;
    return ref;
  };
  const submit = fixture.dependencies.terminalPlugin.submitText.bind(
    fixture.dependencies.terminalPlugin,
  );
  fixture.dependencies.terminalPlugin.submitText = async (tab, text, chord) => {
    assert.equal(text, "continue");
    await submit(tab, text, chord);
    fixture.state.evidence.commits = committed().commits;
    await publish(saved.invocation!.path, committed());
  };
  const result = await executeCli(implementationCommand, {
    ...fixture.dependencies,
    signal: new AbortController().signal,
  });
  assert.match(result.summary.reasons.join(" "), /CI-ready/);
  assert.equal(resumes, 1);
  assert.equal(fixture.state.probeCount, 0);
  assert.equal(fixture.state.taskCount, 1);
  assert.equal(
    (await fixture.snapshot()).publication?.title,
    committed().pr_title,
  );
});

await test("a returned identity checkpoint can resume before the first business assignment exists", async (t) => {
  const fixture = await implementationRun(t);
  fixture.dependencies.terminalPlugin.start = async () => "saved-native";
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
  fixture.dependencies.terminalPlugin.resume = async (_tab, _command, ref) => {
    assert.equal(ref, "saved-native");
    return ref;
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
  assert.equal(fixture.state.probeCount, 0);
});

await test("documentation publishes metadata from its handoff without an identity Probe", async (t) => {
  const fixture = await documentationRun(t);
  fixture.dependencies.terminalPlugin.start = async (_tab, command) => {
    assert.equal(command, "document-cli");
    return "document-native";
  };
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
  assert.equal(
    (await fixture.snapshot()).publication?.body,
    "Document body. Closes #50",
  );
  assert.equal(fixture.state.probeCount, 0);
});

await test("returned refs preserve independent implementation and Review roles through a Review fix", async (t) => {
  const fixture = await reviewRun(t, 1);
  fixture.dependencies.terminalPlugin.start = async (_tab, command) =>
    command === "review-cli start" ? "review-native" : "implement-native";
  fixture.dependencies.terminalPlugin.resume = async (_tab, command, ref) => {
    assert.equal(ref, "implement-native");
    assert.equal(command, 'any-cli --resume "implement-native"');
    return ref;
  };
  fixture.reviewState.onReview = findings;
  assert.match((await fixture.run()).summary.reasons.join(" "), /CI-ready/);
  const saved = await fixture.snapshot();
  assert.deepEqual(saved.roles, {
    implement: { sessionid: "implement-native" },
    review: { sessionid: "review-native" },
  });
  assert.equal(fixture.state.probeCount, 0);
  assert.equal(fixture.reviewState.fixes.length, 1);
});

await test("returned repair refs persist on the repair attempt independently of the implementation role", async (t) => {
  const fixture = await ciRepairRun(t);
  let starts = 0;
  fixture.dependencies.terminalPlugin.start = async () =>
    ++starts === 1 ? "implement-native" : "repair-native";
  const task = fixture.repairs.onTask;
  fixture.repairs.onTask = async (file, evidence) => {
    const saved = await fixture.snapshot();
    assert.equal(saved.roles.implement?.sessionid, "implement-native");
    assert.equal(
      saved.publication?.ciRepair?.attempts.at(-1)?.sessionid,
      "repair-native",
    );
    await task(file, evidence);
  };
  assert.match((await fixture.run()).summary.reasons.join(" "), /CI-ready/);
  assert.equal(fixture.state.probeCount, 0);
  assert.deepEqual(fixture.repairs.probes, []);
});
