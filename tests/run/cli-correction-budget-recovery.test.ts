/* eslint-disable @typescript-eslint/require-await -- Scripted external boundaries. */
import assert from "node:assert/strict";
import { readdir, rm } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { executeCli } from "../../src/cli.ts";
import { validConfig } from "../support/cli-project.ts";
import {
  committed,
  implementationCommand,
  implementationRun,
  publish,
} from "../support/implementation-run.ts";
import { passed, reviewRun } from "../support/review-run.ts";

for (const recover of [false, true]) {
  await test(`a result arriving during correction backoff is validated before dispatch${recover ? " after matching recovery" : ""}`, async (t) => {
    const fixture = await implementationRun(t);
    fixture.state.onTask = async (file) => {
      fixture.state.evidence.commits = committed().commits;
      await publish(file, {});
    };
    fixture.state.onCorrection = async () => {
      assert.fail(
        "a valid active result must be accepted before correction dispatch",
      );
    };
    if (recover) {
      fixture.state.onSleep = async (ms) => {
        if (ms === 2_000) fixture.controller.abort();
      };
      assert.equal((await fixture.run()).summary.outcome, "cancelled");
    }
    let active: Awaited<ReturnType<typeof fixture.snapshot>>["invocation"];
    fixture.state.onSleep = async (ms) => {
      if (ms !== 2_000) return;
      active = (await fixture.snapshot()).invocation!;
      await publish(active.path, committed());
    };
    const before = fixture.state.submissions.length;
    const result = await executeCli(implementationCommand, {
      ...fixture.dependencies,
      signal: new AbortController().signal,
    });
    assert.match(result.summary.reasons.join(" "), /CI-ready/u);
    assert.ok(active);
    assert.equal(
      fixture.state.submissions.filter(({ text }) =>
        text.startsWith("Correct the"),
      ).length,
      0,
    );
    if (recover) assert.equal(fixture.state.submissions.length, before);
    const saved = await fixture.snapshot();
    assert.deepEqual(saved.invocation, active);
    assert.deepEqual(saved.result, committed());
    assert.equal(saved.corrections, 1);
  });
}

await test("matching rerun waits only the remaining correction delay and keeps the allocated correction", async (t) => {
  const fixture = await implementationRun(t, {
    ...validConfig,
    agentRetry: 3,
    agentRetryDelay: [2, 5],
  });
  let now = Date.parse("2026-10-30T00:00:00Z");
  fixture.dependencies.clock.now = () => new Date(now);
  fixture.state.onTask = async (file) => {
    fixture.state.evidence.commits = committed().commits;
    await publish(file, {});
  };
  fixture.state.onCorrection = async (file) => publish(file, {});
  fixture.state.onSleep = async (ms) => {
    now += ms === 5_000 ? 2_000 : ms;
    if (ms === 5_000) fixture.controller.abort();
  };
  assert.equal((await fixture.run()).summary.outcome, "cancelled");
  const saved = await fixture.snapshot();
  assert.equal(saved.corrections, 2);
  assert.equal(saved.superseded.length, 2);
  const before = fixture.state.submissions.length;
  const sleeps: number[] = [];
  fixture.state.onSleep = async (ms) => {
    sleeps.push(ms);
    now += ms;
  };
  fixture.state.onCorrection = async (file) => publish(file, committed());
  const result = await executeCli(implementationCommand, {
    ...fixture.dependencies,
    signal: new AbortController().signal,
  });
  assert.match(result.summary.reasons.join(" "), /CI-ready/u);
  assert.deepEqual(sleeps.slice(0, 2), [3_000, 10_000]);
  const resumed = fixture.state.submissions.slice(before);
  assert.equal(resumed[0]!.text, 'any-cli --resume "native/$&/$`/$\'/session"');
  assert.match(resumed[1]!.text, /^Correct the implementation handoff:/u);
  assert.equal(resumed.length, 2);
  const recovered = await fixture.snapshot();
  assert.equal(recovered.corrections, 2);
  assert.deepEqual(recovered.invocation, saved.invocation);
  assert.deepEqual(recovered.superseded, saved.superseded);
});

await test("an invalid retained Review uses only its remaining correction in the original reviewer conversation", async (t) => {
  const fixture = await reviewRun(t, 1, { agentRetry: 2 });
  fixture.reviewState.onReview = async (round) =>
    publish(round.invocation!.path, {});
  fixture.reviewState.onCorrection = async () => fixture.controller.abort();
  assert.equal((await fixture.run()).summary.outcome, "cancelled");
  const saved = await fixture.snapshot();
  const round = saved.reviews![0]!;
  assert.equal(round.corrections, 1);
  await publish(round.invocation!.path, {});
  fixture.reviewState.onCorrection = async (current) =>
    publish(current.invocation!.path, passed());
  const before = fixture.state.submissions.length;
  const sleeps = fixture.state.sleeps.length;
  const result = await executeCli(implementationCommand, {
    ...fixture.dependencies,
    signal: new AbortController().signal,
  });
  assert.match(result.summary.reasons.join(" "), /CI-ready/u);
  assert.deepEqual(
    fixture.state.sleeps.slice(sleeps, sleeps + 2),
    [3_000, 10_000],
  );
  const resumed = fixture.state.submissions.slice(before);
  assert.equal(resumed.length, 2);
  assert.equal(resumed[0]!.text, 'review-cli resume "review-native/$&"');
  assert.match(resumed[1]!.text, /^Correct the Review handoff:/u);
  const recovered = await fixture.snapshot();
  assert.equal(recovered.reviews![0]!.corrections, 2);
  assert.deepEqual(recovered.reviews![0]!.superseded, [
    ...round.superseded,
    round.invocation!.path,
  ]);
  assert.deepEqual(recovered.roles, saved.roles);
  assert.equal(recovered.execution_id, saved.execution_id);
  assert.equal(recovered.pr_body, saved.pr_body);
});

await test("operation retries keep their remaining delay and exhausted pause across matching reruns", async (t) => {
  const fixture = await implementationRun(t, {
    ...validConfig,
    operationRetry: 2,
    operationRetryDelay: [4, 7],
  });
  const inspect = fixture.dependencies.gitWorkspace.inspect.bind(
    fixture.dependencies.gitWorkspace,
  );
  let attempts = 0;
  let unavailable = true;
  fixture.dependencies.gitWorkspace.inspect = async (input) => {
    if (fixture.state.taskCount) {
      attempts += 1;
      if (unavailable) throw new Error("Git inspection unavailable");
    }
    return inspect(input);
  };
  let now = Date.parse("2026-10-30T00:00:00Z");
  fixture.dependencies.clock.now = () => new Date(now);
  fixture.state.onSleep = async (ms) => {
    now += ms === 4_000 ? 1_500 : ms;
    if (ms === 4_000) fixture.controller.abort();
  };
  assert.equal((await fixture.run()).summary.outcome, "cancelled");
  assert.equal(attempts, 1);
  const saved = await fixture.snapshot();
  const before = fixture.state.submissions.length;
  const sleeps: number[] = [];
  fixture.state.onSleep = async (ms) => {
    sleeps.push(ms);
    now += ms;
  };
  let pauses = 0;
  fixture.dependencies.operator.pause = async (message) => {
    assert.match(message, /Operation failed: Git inspection unavailable/u);
    pauses += 1;
    return "q";
  };
  const resume = () =>
    executeCli(implementationCommand, {
      ...fixture.dependencies,
      signal: new AbortController().signal,
    });
  assert.equal((await resume()).summary.outcome, "cancelled");
  assert.deepEqual(sleeps, [2_500, 7_000]);
  assert.equal(attempts, 3);
  assert.equal(pauses, 1);
  assert.equal((await resume()).summary.outcome, "cancelled");
  assert.equal(attempts, 3);
  assert.equal(pauses, 2);
  assert.equal(fixture.state.submissions.length, before);
  assert.equal((await fixture.snapshot()).corrections, 0);
  unavailable = false;
  fixture.dependencies.operator.pause = async () => "";
  assert.match((await resume()).summary.reasons.join(" "), /CI-ready/u);
  const recovered = await fixture.snapshot();
  assert.deepEqual(recovered.invocation, saved.invocation);
  assert.equal(recovered.corrections, 0);
  assert.equal(fixture.state.submissions.length, before);
});

for (const category of ["correction", "operation"] as const) {
  await test(`matching rerun restores a fractional ${category} delay`, async (t) => {
    const fixture = await implementationRun(t, {
      ...validConfig,
      agentRetryDelay: [0.0001],
      operationRetryDelay: [0.0001],
    });
    if (category === "correction") {
      fixture.state.onTask = async (file) => {
        fixture.state.evidence.commits = committed().commits;
        await publish(file, {});
      };
    } else {
      const inspect = fixture.dependencies.gitWorkspace.inspect.bind(
        fixture.dependencies.gitWorkspace,
      );
      let failed = false;
      fixture.dependencies.gitWorkspace.inspect = async (input) => {
        if (fixture.state.taskCount && !failed) {
          failed = true;
          throw new Error("inspection unavailable");
        }
        return inspect(input);
      };
    }
    fixture.state.onSleep = async (ms) => {
      if (ms < 1) fixture.controller.abort();
    };
    assert.equal((await fixture.run()).summary.outcome, "cancelled");
    const saved = await fixture.snapshot();
    const deadline =
      category === "correction"
        ? saved.correctionNotBefore
        : Object.values(saved.operations!).find(
            (operation) => operation.notBefore !== undefined,
          )!.notBefore;
    assert.ok(Number.isFinite(deadline));
    assert.equal(Number.isInteger(deadline), false);
    let fractionalWait = false;
    fixture.state.onSleep = async (ms) => {
      if (ms < 1) {
        assert.ok(ms > 0);
        fractionalWait = true;
      }
    };
    const result = await executeCli(implementationCommand, {
      ...fixture.dependencies,
      signal: new AbortController().signal,
    });
    assert.match(result.summary.reasons.join(" "), /CI-ready/u);
    assert.ok(fractionalWait);
    const recovered = await fixture.snapshot();
    assert.deepEqual(recovered.invocation, saved.invocation);
    assert.equal(recovered.corrections, category === "correction" ? 1 : 0);
  });
}

await test("exhausted recovery displays the same manual path before continue and ignores superseded results", async (t) => {
  const fixture = await implementationRun(t, { ...validConfig, agentRetry: 1 });
  fixture.state.onTask = async (file) => {
    fixture.state.evidence.commits = committed().commits;
    await publish(file, {});
  };
  fixture.state.onCorrection = async (file) => publish(file, {});
  fixture.state.onSleep = async (ms) => {
    if (ms === 250) fixture.controller.abort();
  };
  assert.equal((await fixture.run()).summary.outcome, "cancelled");
  const saved = await fixture.snapshot();
  assert.equal(saved.correctionExhausted, true);
  await publish(saved.superseded[0]!, committed());
  await rm(saved.invocation!.path);
  const before = fixture.state.submissions.length;
  const messages = fixture.dependencies.messages.length;
  let polls = 0;
  fixture.state.onSleep = async (ms) => {
    if (ms !== 250) return;
    assert.ok(++polls <= 3);
    assert.equal((await fixture.snapshot()).result, undefined);
    if (polls === 1) await publish(saved.invocation!.path, {});
    if (polls === 2) await publish(saved.invocation!.path, committed());
  };
  const plugin = fixture.dependencies.terminalPlugin;
  const result = await executeCli(implementationCommand, {
    ...fixture.dependencies,
    signal: new AbortController().signal,
    terminalPlugin: {
      ...plugin,
      async createTab(options) {
        assert.ok(
          fixture.dependencies.messages
            .slice(messages)
            .some((message) =>
              message.includes("Automatic correction budget exhausted"),
            ),
        );
        assert.equal(options.cwd, saved.worktree);
        return plugin.createTab(options);
      },
    },
  });
  assert.match(result.summary.reasons.join(" "), /CI-ready/u);
  assert.deepEqual(
    fixture.state.submissions.slice(before).map(({ text }) => text),
    ['any-cli --resume "native/$&/$`/$\'/session"', "continue"],
  );
  const recovered = await fixture.snapshot();
  assert.equal(recovered.corrections, 1);
  assert.equal(recovered.correctionExhausted, true);
  assert.deepEqual(recovered.invocation, saved.invocation);
  assert.deepEqual(recovered.superseded, saved.superseded);
  assert.deepEqual(recovered.result, committed());
});

for (const interruptedAttempt of [1, 2]) {
  await test(`cancellation inside operation attempt ${interruptedAttempt} cannot reclaim that attempt on rerun`, async (t) => {
    const fixture = await implementationRun(t, {
      ...validConfig,
      operationRetry: 1,
    });
    const inspect = fixture.dependencies.gitWorkspace.inspect.bind(
      fixture.dependencies.gitWorkspace,
    );
    let attempts = 0;
    fixture.dependencies.gitWorkspace.inspect = async (input) => {
      if (!fixture.state.taskCount) return inspect(input);
      attempts += 1;
      if (attempts === interruptedAttempt) fixture.controller.abort();
      throw new Error("inspection interrupted");
    };
    assert.equal((await fixture.run()).summary.outcome, "cancelled");
    assert.equal(attempts, interruptedAttempt);
    fixture.dependencies.operator.pause = async (message) => {
      assert.match(message, /Operation failed:/u);
      return "q";
    };
    const resumed = await executeCli(implementationCommand, {
      ...fixture.dependencies,
      signal: new AbortController().signal,
    });
    assert.equal(resumed.summary.outcome, "cancelled");
    assert.equal(attempts, 2);
    assert.equal((await fixture.snapshot()).corrections, 0);
  });
}

for (const invalid of [
  { correctionNotBefore: -1 },
  { correctionExhausted: true },
  { operations: { inspection: { consumed: -1, error: "unavailable" } } },
  {
    operations: {
      inspection: { consumed: 1, error: "unavailable", notBefore: "tomorrow" },
    },
  },
]) {
  await test(`recovery rejects invalid retry state ${JSON.stringify(invalid)} before dispatch`, async (t) => {
    const fixture = await implementationRun(t);
    fixture.state.onTask = async () => fixture.controller.abort();
    assert.equal((await fixture.run()).summary.outcome, "cancelled");
    const saved = await fixture.snapshot();
    const recovery = path.join(fixture.directory, "recovery");
    const [file] = await readdir(recovery);
    await publish(path.join(recovery, file!), { ...saved, ...invalid });
    const before = fixture.state.submissions.length;
    fixture.dependencies.operator.pause = async () => "q";
    const result = await executeCli(implementationCommand, {
      ...fixture.dependencies,
      signal: new AbortController().signal,
      terminalPlugin: {
        ...fixture.dependencies.terminalPlugin,
        async createTab() {
          assert.fail("invalid retry checkpoints cannot dispatch follow-ups");
        },
      },
    });
    assert.match(result.summary.reasons.join(" "), /unable to recover/u);
    assert.equal(fixture.state.submissions.length, before);
  });
}
