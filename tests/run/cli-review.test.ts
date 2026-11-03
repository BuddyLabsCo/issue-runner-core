import { promptAssignment } from "../support/prompt-assignment.ts";
import assert from "node:assert/strict";
import test from "node:test";
import { implementationRun, publish } from "../support/implementation-run.ts";
import { validConfig } from "../support/cli-project.ts";
import {
  findings,
  fixCommit,
  passed,
  reviewRun,
} from "../support/review-run.ts";
import { access, readFile } from "node:fs/promises";
import { implementationCommit } from "../support/implementation-run.ts";
import { loadPrompt, renderPrompt } from "../../src/prompts/load.ts";

await test("verified implementation starts an independent Standards/Spec Review and becomes eligible for publication on passed", async (t) => {
  const fixture = await implementationRun(t, {
    ...validConfig,
    workflow: { review: true },
    agents: {
      ...validConfig.agents,
      implement: { ...validConfig.agents.implement, startupDelaySeconds: 20 },
      review: {
        ...validConfig.agents.review,
        start: "review-cli start",
        resume: 'review-cli resume "{sessionref}"',
        startupDelaySeconds: 0.5,
      },
    },
  });
  const submit = fixture.dependencies.terminalPlugin.submitText.bind(
    fixture.dependencies.terminalPlugin,
  );
  let reviews = 0;
  fixture.dependencies.terminalPlugin.submitText = async (tab, text, chord) => {
    if (text.startsWith("Session Probe\n") && text.includes("-review-probe-")) {
      assert.equal(fixture.state.closedTabs.length, 1);
      assert.doesNotMatch(text, /pr_title|pr_body/u);
      assert.ok(
        text.includes('{\n  "sessionid": "actual_native_session_id"\n}'),
      );
      assert.doesNotMatch(text, /\{\{/u);
      const assignment = promptAssignment(text) as { path: string };
      await publish(assignment.path, {
        sessionid: "native-review",
      });
    } else if (text.startsWith("Review assignment\n")) {
      reviews += 1;
      const assignment = promptAssignment(text) as { path: string };
      assert.match(text, /repository instructions/u);
      assert.match(text, /issue requirements/u);
      assert.match(text, /Project review instructions/u);
      assert.match(text, /Review issue #50/u);
      assert.doesNotMatch(
        text,
        /Accepted scope|Worktree:|Delivery branch:|Fixed PR/u,
      );
      assert.ok(text.includes("a".repeat(40)));
      assert.ok(text.includes("b".repeat(40)));
      assert.match(text, /issue-runner-handoff/u);
      await publish(assignment.path, {
        outcome: "passed",
        summary: "Standards and Spec checked.",
        commits: [],
        findings_file: null,
      });
    } else {
      await submit(tab, text, chord);
    }
  };
  const result = await fixture.run();
  assert.equal(result.summary.outcome, "incomplete", JSON.stringify(result));
  assert.equal(reviews, 1);
  assert.match(result.summary.reasons.join(" "), /CI-ready/u);
  assert.equal(fixture.state.closedTabs.length, 2);
  assert.deepEqual(
    fixture.state.sleeps.filter((ms) => ms !== 30_000),
    [20_000, 500],
  );
  assert.equal(
    (await fixture.snapshot()).roles.review?.sessionid,
    "native-review",
  );
});

await test("with no default cap, every findings round receives a fix and later Reviews resume the original reviewer from the previous reviewed HEAD", async (t) => {
  const fixture = await reviewRun(t);
  const labels: string[] = [];
  const createTab = fixture.dependencies.terminalPlugin.createTab.bind(
    fixture.dependencies.terminalPlugin,
  );
  fixture.dependencies.terminalPlugin.createTab = async (options) => {
    labels.push(options.label);
    return createTab(options);
  };
  const probe = fixture.state.onProbe;
  fixture.state.onProbe = async (assignment) => {
    if (assignment.role === "review")
      assert.equal(
        fixture.dependencies.messages.some((message) =>
          message.startsWith("Issue #50 review round"),
        ),
        false,
      );
    await probe(assignment);
  };
  const fixes = [
    fixCommit,
    { sha: "d".repeat(40), message: "fix: resolve second Review" },
    { sha: "e".repeat(40), message: "fix: resolve third Review" },
  ];
  fixture.reviewState.onReview = async (round) => {
    assert.ok(
      fixture.dependencies.messages.includes(
        `Issue #50 review round ${round.round} sessionid=review-native/$& handoff=${round.invocation!.path}`,
      ),
    );
    const prompt = fixture.state.submissions.at(-1)!.text;
    assert.equal(
      prompt,
      renderPrompt(loadPrompt("review"), {
        issue: "50",
        instructions: await readFile(
          `${fixture.directory}/prompts/review.md`,
          "utf8",
        ),
        round: String(round.round),
        base: round.base,
        head: round.head,
        findings: JSON.stringify(round.findings),
        path: JSON.stringify(round.invocation!.path),
      }),
    );
    assert.ok(prompt.includes(`\n- Review round: ${round.round}\n`));
    assert.ok(
      prompt.includes(
        `Review base: ${round.round === 1 ? "a".repeat(40) : ["b", "c", "d"][round.round - 2]!.repeat(40)}`,
      ),
    );
    if (round.round <= 3) await findings(round);
    else await publish(round.invocation!.path, passed());
  };
  fixture.reviewState.onFix = async (round) => {
    assert.ok(
      fixture.dependencies.messages.includes(
        `Issue #50 fix review round ${round.round} sessionid=native/$&/$\u0060/$'/session handoff=${round.fix!.invocation!.path}`,
      ),
    );
    const commit = fixes[round.round - 1]!;
    fixture.state.evidence.commits.push(commit);
    await publish(round.fix!.invocation!.path, {
      outcome: "committed",
      summary: "Resolved this round.",
      commits: [commit],
      findings_file: null,
    });
  };
  const result = await fixture.run();
  assert.match(result.summary.reasons.join(" "), /CI-ready/u);
  assert.equal(fixture.reviewState.reviews.length, 4);
  assert.equal(fixture.reviewState.fixes.length, 3);
  assert.deepEqual(labels, [
    "issue-50 implement",
    "issue-50 review r1",
    "issue-50 fix review r1",
    "issue-50 review r2",
    "issue-50 fix review r2",
    "issue-50 review r3",
    "issue-50 fix review r3",
    "issue-50 review r4",
  ]);
  assert.deepEqual(
    fixture.dependencies.messages
      .filter((message) => /^Issue #50 (?:review|fix review)/u.test(message))
      .map((message) => message.split(" sessionid=")[0]),
    [
      "Issue #50 review round 1",
      "Issue #50 fix review round 1",
      "Issue #50 review round 2",
      "Issue #50 fix review round 2",
      "Issue #50 review round 3",
      "Issue #50 fix review round 3",
      "Issue #50 review round 4",
    ],
  );
  assert.equal(fixture.state.probeCount, 2);
  assert.equal(fixture.state.closedTabs.length, 8);
  assert.deepEqual(
    fixture.state.sleeps.filter((ms) => ms !== 30_000),
    Array<number>(8).fill(10_000),
  );
  const reviewerCommands = fixture.state.submissions.filter((item) =>
    item.text.startsWith("review-cli"),
  );
  assert.deepEqual(
    reviewerCommands.map((item) => item.text),
    [
      "review-cli start",
      'review-cli resume "review-native/$&"',
      'review-cli resume "review-native/$&"',
      'review-cli resume "review-native/$&"',
    ],
  );
  assert.equal(new Set(reviewerCommands.map((item) => item.tab)).size, 4);
  assert.equal(
    (await fixture.snapshot()).pr_body,
    "Implement the Issue.\n\nCloses #50",
  );
});

await test("disabled Review and initial no_change never start a reviewer", async (t) => {
  const disabled = await implementationRun(t);
  const result = await disabled.run();
  assert.equal(result.summary.outcome, "incomplete");
  assert.match(result.summary.reasons.join(" "), /CI-ready/u);
  assert.equal(disabled.state.closedTabs.length, 1);
  assert.equal((await disabled.snapshot()).reviews, undefined);

  const unchanged = await reviewRun(t);
  unchanged.state.onTask = async (file) => {
    unchanged.state.evidence.changed = false;
    await publish(file, {
      outcome: "no_change",
      summary: "Nothing to implement.",
      commits: [],
      findings_file: null,
    });
  };
  assert.equal((await unchanged.run()).summary.outcome, "incomplete");
  assert.equal(unchanged.reviewState.reviews.length, 0);
  assert.equal(unchanged.state.closedTabs.length, 1);
});

await test("cap=1 still fixes final findings in the exact implementation conversation before publication eligibility", async (t) => {
  const fixture = await reviewRun(t, 1);
  fixture.reviewState.onReview = findings;
  fixture.reviewState.onFix = async (round) => {
    assert.equal(fixture.state.closedTabs.length, 2);
    assert.match(
      await readFile(round.findings, "utf8"),
      /missing accepted behavior/u,
    );
    const prompt = fixture.state.submissions.at(-1)!.text;
    assert.doesNotMatch(prompt, /Fixed PR|Worktree:|Delivery branch:/u);
    assert.ok(prompt.includes("b".repeat(40)));
    fixture.state.evidence.commits.push(fixCommit);
    await publish(round.fix!.invocation!.path, {
      outcome: "committed",
      summary: "Fixed all actionable findings.",
      commits: [fixCommit],
      findings_file: null,
    });
  };
  const result = await fixture.run();
  assert.equal(result.summary.outcome, "incomplete", JSON.stringify(result));
  assert.match(result.summary.reasons.join(" "), /CI-ready/u);
  assert.equal(fixture.reviewState.reviews.length, 1);
  assert.equal(fixture.reviewState.fixes.length, 1);
  assert.equal(fixture.state.closedTabs.length, 3);
  assert.deepEqual(
    fixture.state.tabOptions.map(({ agent, submitKey }) => ({
      agent,
      submitKey,
    })),
    [
      { agent: "custom-agent", submitKey: "Shift+Enter" },
      { agent: "review-agent", submitKey: "Shift+Enter" },
      { agent: "custom-agent", submitKey: "Shift+Enter" },
    ],
  );
  assert.ok(
    fixture.state.tabOptions.every(
      ({ signal }) => signal instanceof AbortSignal && !signal.aborted,
    ),
  );

  assert.deepEqual(
    fixture.state.sleeps.filter((ms) => ms !== 30_000),
    [10_000, 10_000, 10_000],
  );
  const commands = fixture.state.submissions.filter(
    (item) => item.chord === "Enter",
  );
  assert.equal(
    commands[2]!.text,
    'any-cli --resume "native/$&/$`/$\'/session"',
  );
  const saved = await fixture.snapshot();
  assert.equal(saved.phase, "publication_eligible");
  assert.equal(saved.pr_body, "Implement the Issue.\n\nCloses #50");
  assert.deepEqual(saved.result?.commits, [implementationCommit]);
  assert.deepEqual(saved.reviews?.[0]?.fix?.result?.commits, [fixCommit]);
  assert.equal(saved.publication?.headSha, fixCommit.sha);
  assert.deepEqual(saved.publication.commits, [
    implementationCommit,
    fixCommit,
  ]);
  assert.equal(saved.publication.body, "Implement the Issue.\n\nCloses #50");
  await assert.rejects(access(saved.reviews[0].findings));
  assert.equal(new Set(fixture.state.gitConfigs).size, 3);
  for (const file of fixture.state.gitConfigs)
    await assert.rejects(access(file));
  const submissions = fixture.state.submissions.length;
  assert.match((await fixture.run()).summary.reasons.join(" "), /CI-ready/u);
  assert.equal(fixture.state.submissions.length, submissions);
  fixture.controller.abort();
  assert.ok(fixture.state.tabOptions.every(({ signal }) => signal?.aborted));
});
