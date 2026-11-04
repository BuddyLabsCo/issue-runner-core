/* eslint-disable @typescript-eslint/require-await -- Scripted external boundaries. */
import { terminalModule } from "../support/cli-dependencies.ts";
import assert from "node:assert/strict";
import { access, mkdir, readdir, rmdir, writeFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { executeCli } from "../../src/cli.ts";
import { assertBusinessAssignment } from "../support/prompt-assignment.ts";
import {
  execution as committed,
  implementationCommand,
  publish,
} from "../support/implementation-run.ts";
import {
  findings,
  fixCommit,
  passed,
  reviewRun,
} from "../support/review-run.ts";

await test("an interrupted later Review resumes the original reviewer with its preserved incremental base", async (t) => {
  const fixture = await reviewRun(t);
  fixture.reviewState.onReview = async (round) => {
    if (round.round === 1) await findings(round);
  };
  fixture.state.onSleep = async (ms) => {
    if (ms === 250) fixture.controller.abort();
  };
  assert.equal((await fixture.run()).summary.outcome, "cancelled");
  const saved = await fixture.snapshot();
  for (const stage of [
    saved,
    ...saved.reviews!.flatMap((round) => [
      round,
      ...(round.fix ? [round.fix] : []),
    ]),
  ])
    Object.assign(stage, {
      corrections: "obsolete",
      probeRetries: -1,
      correctionNotBefore: "ignored",
      correctionExhausted: true,
    });
  await writeFile(
    path.join(fixture.directory, "recovery", `${saved.input_hash}-50.json`),
    JSON.stringify(saved),
  );
  assert.equal(saved.reviews![1]!.base, "b".repeat(40));
  assert.equal(saved.reviews![1]!.head, fixCommit.sha);
  await access(saved.reviews![0]!.findings);
  const before = fixture.state.submissions.length;
  fixture.state.onSleep = async (ms) => {
    if (ms === 250)
      await publish(saved.reviews![1]!.invocation!.path, passed());
  };
  const result = await executeCli(implementationCommand, {
    ...fixture.dependencies,
    signal: new AbortController().signal,
  });
  assert.match(result.summary.reasons.join(" "), /CI-ready/u);
  assert.deepEqual(
    fixture.state.submissions.slice(before).map((item) => item.text),
    ['review-cli resume "review-native/$&"', "continue"],
  );
  const continuation = fixture.state.submissions.at(-1)!;
  assertBusinessAssignment(
    continuation,
    saved.reviews![1]!.invocation!.path,
    "Review",
  );
  assert.equal(continuation.chord, "Shift+Enter");
  assert.equal(continuation.tab, fixture.state.submissions[before]!.tab);
  assert.equal(fixture.reviewState.reviews.length, 2);
  assert.equal(fixture.reviewState.fixes.length, 1);
  assert.equal(fixture.state.probeCount, 2);
  const current = await fixture.snapshot();
  for (const stage of [
    current,
    ...current.reviews!.flatMap((round) => [
      round,
      ...(round.fix ? [round.fix] : []),
    ]),
  ])
    for (const key of [
      "corrections",
      "probeRetries",
      "correctionNotBefore",
      "correctionExhausted",
    ])
      assert.equal(Object.hasOwn(stage, key), false);
});

for (const stage of ["review", "fix"] as const) {
  await test(`a ${stage} result published while stopped completes without opening a native tab`, async (t) => {
    const fixture = await reviewRun(t, 1);
    fixture.reviewState.onReview =
      stage === "review"
        ? async () => {
            /* Leave Review in flight. */
          }
        : findings;
    fixture.reviewState.onFix = async () => {
      /* Leave the fix in flight. */
    };
    fixture.state.onSleep = async (ms) => {
      if (ms === 250) fixture.controller.abort();
    };
    assert.equal((await fixture.run()).summary.outcome, "cancelled");
    const saved = await fixture.snapshot();
    const round = saved.reviews![0]!;
    if (stage === "review") await publish(round.invocation!.path, passed());
    else {
      fixture.state.evidence.commits.push(fixCommit);
      await publish(round.fix!.invocation!.path, {
        ...committed(),
        commits: [fixCommit],
      });
    }
    const before = fixture.state.submissions.length;
    const result = await executeCli(implementationCommand, {
      ...fixture.dependencies,
      signal: new AbortController().signal,
      terminal: terminalModule({
        ...fixture.dependencies.terminalPlugin,
        async createTab() {
          assert.fail("valid retained results need no native tab");
        },
      }),
    });
    assert.match(result.summary.reasons.join(" "), /CI-ready/u);
    assert.equal(fixture.state.submissions.length, before);
    assert.equal((await fixture.snapshot()).phase, "publication_eligible");
  });
}

for (const mismatch of ["dirty", "wrong branch"] as const) {
  await test(`a persisted passed Review with ${mismatch} evidence cannot restore publication eligibility`, async (t) => {
    const fixture = await reviewRun(t, 1);
    fixture.state.onClose = async () => {
      if (fixture.state.closedTabs.length === 2) fixture.controller.abort();
    };
    assert.equal((await fixture.run()).summary.outcome, "cancelled");
    const saved = await fixture.snapshot();
    assert.equal(saved.phase, "review_completed");
    assert.equal(saved.reviews![0]!.result!.outcome, "passed");
    if (mismatch === "dirty") fixture.state.evidence.clean = false;
    else fixture.state.evidence.branch = "unexpected-branch";
    const before = fixture.state.submissions.length;
    const resume = () =>
      executeCli(implementationCommand, {
        ...fixture.dependencies,
        signal: new AbortController().signal,
      });
    const result = await resume();
    assert.equal(result.summary.outcome, "failed", JSON.stringify(result));
    assert.match(
      result.summary.reasons.join(" "),
      mismatch === "dirty"
        ? /Worktree must be clean/u
        : /Delivery branch mismatch/u,
    );
    assert.equal((await fixture.snapshot()).phase, "review_completed");
    assert.equal(fixture.state.submissions.length, before);

    fixture.state.evidence.clean = true;
    fixture.state.evidence.branch = saved.branch;
    const recovered = await resume();
    assert.match(recovered.summary.reasons.join(" "), /CI-ready/u);
    assert.equal((await fixture.snapshot()).phase, "publication_eligible");
    assert.equal(fixture.state.submissions.length, before);
    assert.deepEqual((await fixture.snapshot()).reviews, saved.reviews);
  });
}

for (const missing of [
  "reviewer identity",
  "findings ownership",
  "Review base",
  "fix path",
] as const) {
  await test(`an invalid retained ${missing} is rejected before native dispatch`, async (t) => {
    const fixture = await reviewRun(t, 1);
    fixture.reviewState.onReview = findings;
    fixture.reviewState.onFix = async () => {
      /* Leave the fix in flight. */
    };
    fixture.state.onSleep = async (ms) => {
      if (ms === 250) fixture.controller.abort();
    };
    assert.equal((await fixture.run()).summary.outcome, "cancelled");
    const saved = await fixture.snapshot();
    if (missing === "reviewer identity") delete saved.roles.review;
    if (missing === "findings ownership")
      saved.reviews![0]!.findings = path.join(
        fixture.directory,
        "unowned-report.md",
      );
    if (missing === "Review base") saved.reviews![0]!.base = "f".repeat(40);
    if (missing === "fix path")
      saved.reviews![0]!.fix!.invocation!.path = "/unowned.json";
    const recovery = path.join(fixture.directory, "recovery");
    const [file] = await readdir(recovery);
    await writeFile(path.join(recovery, file!), JSON.stringify(saved));
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
    });
    assert.equal(result.summary.outcome, "cancelled");
    assert.ok(fixture.dependencies.messages.includes("unable to recover"));
    assert.equal(fixture.state.submissions.length, before);
  });
}

await test("a withheld Review assignment retains its invocation and resumes only its reviewer when eligibility returns", async (t) => {
  const fixture = await reviewRun(t, 1);
  const probe = fixture.state.onProbe;
  fixture.state.onProbe = async (assignment) => {
    await probe(assignment);
    if (assignment.role === "review")
      fixture.state.ticket.labels = ["sandcastle:reserved"];
  };
  assert.equal((await fixture.run()).summary.outcome, "incomplete");
  const saved = await fixture.snapshot();
  const pending = saved.reviews![0]!.pendingPrompt;
  assert.match(pending!, /^Review assignment\n/u);
  assert.equal(fixture.reviewState.reviews.length, 0);
  const before = fixture.state.submissions.length;
  fixture.state.ticket.labels!.push("ready-for-agent");
  const result = await fixture.run();
  assert.match(result.summary.reasons.join(" "), /CI-ready/u);
  assert.deepEqual(
    fixture.state.submissions.slice(before).map((item) => item.text),
    ['review-cli resume "review-native/$&"', pending],
  );
  assert.deepEqual(
    (await fixture.snapshot()).reviews![0]!.invocation,
    saved.reviews![0]!.invocation,
  );
});

for (const stage of ["review", "fix"] as const) {
  await test(`cancellation during ${stage} startup prevents its first prompt and retains context`, async (t) => {
    const fixture = await reviewRun(t, 1);
    if (stage === "fix") fixture.reviewState.onReview = findings;
    const terminal = fixture.dependencies.terminalPlugin;
    const method = stage === "review" ? "start" : "resume";
    const start = terminal.start.bind(terminal);
    const resume = terminal.resume.bind(terminal);
    if (method === "start")
      terminal.start = async (tab, command) => {
        const ref = await start(tab, command);
        if (fixture.state.closedTabs.length === 1) fixture.controller.abort();
        return ref;
      };
    else
      terminal.resume = async (tab, command, sessionref) => {
        const ref = await resume(tab, command, sessionref);
        fixture.controller.abort();
        return ref;
      };
    assert.equal((await fixture.run()).summary.outcome, "cancelled");
    assert.equal(fixture.reviewState.fixes.length, 0);
    if (stage === "review") {
      assert.equal(fixture.state.probeCount, 1);
      assert.equal(fixture.reviewState.reviews.length, 0);
    } else {
      const saved = await fixture.snapshot();
      assert.match(
        saved.reviews![0]!.fix!.pendingPrompt!,
        /^Fix assignment\n/u,
      );
      await access(saved.reviews![0]!.findings);
    }
    for (const file of fixture.state.gitConfigs)
      await assert.rejects(access(file));
  });
}

await test("failed findings cleanup retains the completed checkpoint and retries cleanup without replaying stages", async (t) => {
  const fixture = await reviewRun(t, 1);
  fixture.reviewState.onReview = async (round) => {
    await mkdir(round.findings);
    await publish(round.invocation!.path, passed());
  };
  fixture.dependencies.operator.pause = async () => "q";
  assert.equal((await fixture.run()).summary.outcome, "cancelled");
  const saved = await fixture.snapshot();
  assert.equal(saved.phase, "publication_eligible");
  await rmdir(saved.reviews![0]!.findings);
  fixture.dependencies.operator.pause = async (message) => {
    assert.match(message, /Operation failed:/u);
    return "";
  };
  const before = fixture.state.submissions.length;
  const result = await fixture.run();
  assert.match(result.summary.reasons.join(" "), /CI-ready/u);
  assert.equal(fixture.state.submissions.length, before);
});
