import assert from "node:assert/strict";
import { mkdir, rmdir, writeFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import {
  committed,
  implementationCommit,
  publish,
} from "../support/implementation-run.ts";
import {
  findings,
  fixCommit,
  passed,
  reviewRun,
} from "../support/review-run.ts";

for (const scenario of [
  "wrong purpose",
  "extra field",
  "empty summary",
  "claimed commits",
  "passed findings",
  "wrong findings path",
  "relative findings path",
  "missing report",
  "empty report",
  "directory report",
  "dirty Worktree",
  "reviewer commit",
] as const) {
  await test(`Review rejects ${scenario} and corrects in the same round and conversation`, async (t) => {
    const fixture = await reviewRun(t, 1);
    fixture.reviewState.onReview = async (round) => {
      const result: Record<string, unknown> = passed();
      if (scenario === "wrong purpose") Object.assign(result, committed());
      if (scenario === "extra field") result.checks = [];
      if (scenario === "empty summary") result.summary = " ";
      if (scenario === "claimed commits") result.commits = [fixCommit];
      if (scenario === "passed findings") result.findings_file = round.findings;
      if (scenario.includes("report") || scenario.includes("findings path")) {
        result.outcome = "findings";
        result.findings_file = round.findings;
        if (scenario === "wrong findings path") {
          result.findings_file = `${round.findings}-unassigned`;
          await writeFile(String(result.findings_file), "Findings");
        }
        if (scenario === "relative findings path")
          result.findings_file = path.basename(round.findings);
        if (scenario === "empty report") await writeFile(round.findings, " \n");
        if (scenario === "directory report") await mkdir(round.findings);
      }
      if (scenario === "dirty Worktree") fixture.state.evidence.clean = false;
      if (scenario === "reviewer commit")
        fixture.state.evidence.commits.push(fixCommit);
      await publish(round.invocation!.path, result);
    };
    fixture.reviewState.onCorrection = async (round, purpose) => {
      assert.equal(purpose, "review");
      assert.equal(round.round, 1);
      assert.equal(round.corrections, 1);
      assert.notEqual(
        round.invocation!.path,
        fixture.reviewState.reviews[0]!.invocation!.path,
      );
      assert.equal(fixture.state.closedTabs.length, 1);
      fixture.state.evidence.clean = true;
      fixture.state.evidence.commits = [implementationCommit];
      if (scenario === "directory report") await rmdir(round.findings);
      await publish(round.invocation!.path, passed());
    };
    const result = await fixture.run();
    assert.equal(result.summary.outcome, "incomplete", JSON.stringify(result));
    assert.match(result.summary.reasons.join(" "), /CI-ready/u);
    assert.equal(fixture.reviewState.reviews.length, 1);
    assert.equal(fixture.state.closedTabs.length, 2);
    assert.deepEqual(
      fixture.state.sleeps.filter((ms) => ms !== 30_000),
      [10_000, 10_000, 2000],
    );
    const prompts = fixture.state.submissions.filter(
      (item) =>
        item.text.startsWith("Review assignment") ||
        item.text.startsWith("Correct the Review handoff:"),
    );
    assert.equal(prompts.length, 2);
    assert.equal(prompts[0]!.tab, prompts[1]!.tab);
    assert.ok(
      fixture.dependencies.messages.some((message) =>
        message.includes("Invalid Review handoff:"),
      ),
    );
  });
}

for (const scenario of [
  "PR metadata",
  "generated identity",
  "wrong ownership",
] as const) {
  await test(`reviewer Probe rejects ${scenario} without spending a Review round or correction budget`, async (t) => {
    const fixture = await reviewRun(t, 1);
    const probe = fixture.state.onProbe;
    let reviewProbes = 0;
    fixture.state.onProbe = async (assignment) => {
      if (assignment.role !== "review") return probe(assignment);
      reviewProbes += 1;
      if (reviewProbes > 1) return probe(assignment);
      const invalid: Record<string, unknown> = {
        sessionid: "independent-reviewer",
      };
      if (scenario === "PR metadata") invalid.pr_title = "Not allowed";
      if (scenario === "generated identity") invalid.sessionid = "latest";
      if (scenario === "wrong ownership") invalid.ticket = 999;
      await publish(String(assignment.path), invalid);
    };
    const result = await fixture.run();
    assert.match(result.summary.reasons.join(" "), /CI-ready/u);
    assert.equal(reviewProbes, 2);
    assert.equal(fixture.reviewState.reviews.length, 1);
    const round = (await fixture.snapshot()).reviews![0]!;
    assert.equal(round.probeRetries, 1);
    assert.equal(round.corrections, 0);
    assert.deepEqual(
      fixture.state.sleeps.filter((ms) => ms !== 30_000),
      [10_000, 10_000, 1000],
    );
  });
}

await test("no_change cannot satisfy findings; the correction remains in the fix conversation without another Review", async (t) => {
  const fixture = await reviewRun(t, 1);
  fixture.reviewState.onReview = findings;
  fixture.reviewState.onFix = async (round) => {
    await publish(round.fix!.invocation!.path, {
      outcome: "no_change",
      summary: "No fixes made.",
      commits: [],
      findings_file: null,
    });
  };
  fixture.reviewState.onCorrection = async (round, purpose) => {
    assert.equal(purpose, "fix");
    assert.equal(round.fix!.corrections, 1);
    assert.match(
      fixture.state.submissions.at(-1)!.text,
      /no_change cannot satisfy findings/u,
    );
    fixture.state.evidence.commits.push(fixCommit);
    await publish(round.fix!.invocation!.path, {
      ...committed(),
      commits: [fixCommit],
    });
  };
  const result = await fixture.run();
  assert.match(result.summary.reasons.join(" "), /CI-ready/u);
  assert.equal(fixture.reviewState.reviews.length, 1);
  assert.equal(fixture.reviewState.fixes.length, 1);
  assert.deepEqual(
    fixture.state.sleeps.filter((ms) => ms !== 30_000),
    [10_000, 10_000, 10_000, 2000],
  );
  const prompts = fixture.state.submissions.filter(
    (item) =>
      item.text.startsWith("Fix assignment") ||
      item.text.startsWith("Correct the Review fix handoff:"),
  );
  assert.equal(prompts[0]!.tab, prompts[1]!.tab);
});

for (const scenario of [
  "initial commits included",
  "empty fix",
  "dirty fix",
  "rewritten implementation",
] as const) {
  await test(`a required fix rejects ${scenario} before it can become eligible for publication`, async (t) => {
    const fixture = await reviewRun(t, 1);
    fixture.reviewState.onReview = findings;
    fixture.reviewState.onFix = async (round) => {
      fixture.state.evidence.commits.push(fixCommit);
      if (scenario === "empty fix") fixture.state.evidence.changed = false;
      if (scenario === "dirty fix") fixture.state.evidence.clean = false;
      if (scenario === "rewritten implementation")
        fixture.state.evidence.commits[0] = {
          ...implementationCommit,
          message: "Unapproved rewrite",
        };
      await publish(round.fix!.invocation!.path, {
        ...committed(),
        commits:
          scenario === "initial commits included"
            ? [implementationCommit, fixCommit]
            : [fixCommit],
      });
    };
    fixture.reviewState.onCorrection = async (round, purpose) => {
      assert.equal(purpose, "fix");
      assert.equal(fixture.state.closedTabs.length, 2);
      fixture.state.evidence.changed = true;
      fixture.state.evidence.clean = true;
      fixture.state.evidence.commits = [implementationCommit, fixCommit];
      await publish(round.fix!.invocation!.path, {
        ...committed(),
        commits: [fixCommit],
      });
    };
    const result = await fixture.run();
    assert.match(result.summary.reasons.join(" "), /CI-ready/u);
    assert.equal((await fixture.snapshot()).reviews![0]!.fix!.corrections, 1);
  });
}
