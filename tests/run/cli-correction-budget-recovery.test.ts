/* eslint-disable @typescript-eslint/require-await -- Scripted external boundaries. */
import { terminalModule } from "../support/cli-dependencies.ts";
import assert from "node:assert/strict";
import { readdir } from "node:fs/promises";
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

for (const purpose of ["implementation", "Review"] as const) {
  for (const legacy of ["delay", "exhaustion"] as const) {
    await test(`matching ${purpose} recovery discards legacy Agent ${legacy} without losing native context`, async (t) => {
      const config = {
        ...validConfig,
        agentRetry: 1,
        agentRetryDelay: [300, 300],
      };
      const reviewer =
        purpose === "Review" ? await reviewRun(t, 1, config) : undefined;
      const fixture = reviewer ?? (await implementationRun(t, config));
      if (reviewer) {
        reviewer.reviewState.onReview = async (round) =>
          publish(round.invocation!.path, {});
        reviewer.reviewState.onCorrection = async () => {
          /* Wait for the assigned correction. */
        };
      } else {
        fixture.state.onTask = async (file) => {
          fixture.state.evidence.commits = committed().commits;
          await publish(file, {});
        };
        fixture.state.onCorrection = async () => {
          /* Wait for the assigned correction. */
        };
      }
      fixture.state.onSleep = async (ms) => {
        if (ms === 250) fixture.controller.abort();
      };
      assert.equal((await fixture.run()).summary.outcome, "cancelled");
      const saved = await fixture.snapshot();
      const stage = purpose === "Review" ? saved.reviews![0]! : saved;
      const active = structuredClone(stage.invocation);
      Object.assign(stage, {
        corrections: 999,
        probeRetries: 999,
        ...(legacy === "delay"
          ? {
              pendingPrompt: fixture.state.submissions.at(-1)!.text,
              correctionNotBefore:
                fixture.dependencies.clock.now().getTime() + 300_000,
            }
          : { correctionExhausted: true }),
      });
      if (legacy === "exhaustion") await publish(stage.invocation!.path, {});
      const recovery = path.join(fixture.directory, "recovery");
      const [file] = await readdir(recovery);
      await publish(path.join(recovery, file!), saved);
      const before = fixture.state.submissions.length;
      const sleeps = fixture.state.sleeps.length;
      if (reviewer) {
        reviewer.reviewState.onCorrection = async (round) =>
          publish(round.invocation!.path, passed());
      } else
        fixture.state.onCorrection = async (file) => publish(file, committed());
      const result = await executeCli(implementationCommand, {
        ...fixture.dependencies,
        signal: new AbortController().signal,
      });
      assert.match(result.summary.reasons.join(" "), /CI-ready/u);
      const resumed = fixture.state.submissions.slice(before);
      assert.equal(resumed.length, 2);
      assert.match(resumed[0]!.text, /resume/u);
      assert.match(
        resumed[1]!.text,
        new RegExp(`^Correct the ${purpose} handoff:`),
      );
      assert.deepEqual(
        fixture.state.sleeps.slice(sleeps).filter((ms) => ms !== 30_000),
        [],
      );
      const recovered = await fixture.snapshot();
      const current = purpose === "Review" ? recovered.reviews![0]! : recovered;
      assert.deepEqual(recovered.roles, saved.roles);
      assert.equal(recovered.execution_id, saved.execution_id);
      assert.equal(recovered.worktree, saved.worktree);
      assert.equal(
        recovered.pr_body,
        purpose === "implementation" ? committed().pr_body : saved.pr_body,
      );
      if (legacy === "delay") assert.deepEqual(current.invocation, active);
      else
        assert.deepEqual(current.superseded, [
          ...stage.superseded,
          active!.path,
        ]);
      for (const key of [
        "corrections",
        "probeRetries",
        "correctionNotBefore",
        "correctionExhausted",
      ])
        assert.equal(Object.hasOwn(current, key), false);
    });
  }
}

await test("a valid active result wins over a legacy pending correction before native dispatch", async (t) => {
  const fixture = await implementationRun(t);
  fixture.state.onTask = async (file) => {
    fixture.state.evidence.commits = committed().commits;
    await publish(file, {});
  };
  fixture.state.onCorrection = async () => {
    /* Leave the active assignment pending. */
  };
  fixture.state.onSleep = async (ms) => {
    if (ms === 250) fixture.controller.abort();
  };
  assert.equal((await fixture.run()).summary.outcome, "cancelled");
  const saved = await fixture.snapshot();
  await publish(saved.invocation!.path, committed());
  await publish(
    path.join(fixture.directory, "recovery", `${saved.input_hash}-50.json`),
    {
      ...saved,
      pendingPrompt: fixture.state.submissions.at(-1)!.text,
      corrections: 1,
      correctionNotBefore: fixture.dependencies.clock.now().getTime() + 300_000,
    },
  );
  const before = fixture.state.submissions.length;
  const result = await executeCli(implementationCommand, {
    ...fixture.dependencies,
    signal: new AbortController().signal,
    terminal: terminalModule({
      ...fixture.dependencies.terminalPlugin,
      async createTab() {
        assert.fail("valid active output must precede pending feedback");
      },
    }),
  });
  assert.match(result.summary.reasons.join(" "), /CI-ready/u);
  assert.equal(fixture.state.submissions.length, before);
  assert.deepEqual((await fixture.snapshot()).invocation, saved.invocation);
  assert.deepEqual((await fixture.snapshot()).result, committed());
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
  unavailable = false;
  fixture.dependencies.operator.pause = async () => "";
  assert.match((await resume()).summary.reasons.join(" "), /CI-ready/u);
  const recovered = await fixture.snapshot();
  assert.deepEqual(recovered.invocation, saved.invocation);
  assert.equal(fixture.state.submissions.length, before);
});
for (const category of ["operation"] as const) {
  await test(`matching rerun restores a fractional ${category} delay`, async (t) => {
    const fixture = await implementationRun(t, {
      ...validConfig,
      operationRetryDelay: [0.0001],
    });
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
    fixture.state.onSleep = async (ms) => {
      if (ms < 1) fixture.controller.abort();
    };
    assert.equal((await fixture.run()).summary.outcome, "cancelled");
    const saved = await fixture.snapshot();
    const deadline = Object.values(saved.operations!).find(
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
  });
}

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
  });
}

for (const invalid of [
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
    fixture.dependencies.operator.pause = async (message) => {
      assert.equal(
        message,
        "Enter to restart the entire Issue #50, or q to exit Runner.",
      );
      return "q";
    };
    const result = await executeCli(implementationCommand, {
      ...fixture.dependencies,
      signal: new AbortController().signal,
      terminal: terminalModule({
        ...fixture.dependencies.terminalPlugin,
        async createTab() {
          assert.fail("invalid retry checkpoints cannot dispatch follow-ups");
        },
      }),
    });
    assert.equal(result.summary.outcome, "cancelled");
    assert.ok(fixture.dependencies.messages.includes("unable to recover"));
    assert.equal(fixture.state.submissions.length, before);
  });
}
