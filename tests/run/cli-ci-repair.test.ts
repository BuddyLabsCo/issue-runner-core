/* eslint-disable @typescript-eslint/require-await -- Scripted external boundaries. */
import assert from "node:assert/strict";
import test from "node:test";
import { executeCli } from "../../src/cli.ts";
import type { CodeHost } from "../../src/run/contracts.ts";
import {
  ciRepairRun,
  failedCheck,
  repairCommit,
} from "../support/ci-repair-run.ts";
import { validConfig } from "../support/cli-project.ts";
import {
  deliveryCommand as implementationCommand,
  implementationCommit,
  publish,
} from "../support/implementation-run.ts";
import { passed } from "../support/review-run.ts";

await test("a repaired PR integrates its repaired HEAD and recovers queued and delivered checkpoints", async (t) => {
  const fixture = await ciRepairRun(t);
  let requests = 0;
  let merged = false;
  fixture.dependencies.codeHost.getPullRequest = async () => ({
    headSha: fixture.publicationState.pullRequests[0]!.headSha,
    createdAt: "2026-10-30T00:00:00Z",
    merged,
    mergeRequested: requests > 0,
    mergeable: "mergeable",
    mergeFailure: null,
  });
  Object.assign(fixture.dependencies.codeHost, {
    async requestSquashMerge(
      input: Parameters<CodeHost["requestSquashMerge"]>[0],
    ) {
      assert.equal(input.headSha, repairCommit.sha);
      assert.equal(input.pullRequest, 81);
      requests++;
      return { outcome: "accepted" };
    },
  });
  Object.assign(fixture.dependencies.tracker, {
    async closeTicket() {
      assert.equal(merged, true);
      fixture.state.ticket.state = "closed";
      fixture.state.ticket.stateReason = "completed";
    },
  });
  fixture.state.onSleep = async () => {
    if (requests > 0) fixture.controller.abort();
  };
  const run = () => executeCli(implementationCommand, fixture.dependencies);
  assert.equal((await run()).summary.outcome, "cancelled");
  assert.equal(
    (await fixture.snapshot()).publication!.phase,
    "merge_requested",
  );
  assert.equal(fixture.state.ticket.state, "open");
  fixture.dependencies.signal = new AbortController().signal;
  fixture.state.onSleep = async () => {
    merged = true;
  };
  assert.equal((await run()).summary.outcome, "succeeded");
  const saved = await fixture.snapshot();
  assert.equal(saved.publication!.phase, "delivered");
  assert.equal(saved.publication!.merge!.headSha, repairCommit.sha);
  assert.equal(saved.publication!.headSha, implementationCommit.sha);
  assert.equal(saved.publication!.title, saved.pr_title);
  assert.equal(saved.publication!.body, saved.pr_body);
  assert.deepEqual(fixture.publicationState.discoveries, [40_000, 80_000]);
  assert.equal((await run()).summary.outcome, "succeeded");
  assert.equal(requests, 1);
  assert.equal(fixture.publicationState.creations, 1);
  assert.equal(fixture.publicationState.pushes, 2);
  assert.equal(fixture.repairs.tasks.length, 1);
});

await test("failed required checks receive a verified fresh repair on the same PR and remote branch", async (t) => {
  const fixture = await ciRepairRun(t, {
    ...validConfig,
    agents: {
      ...validConfig.agents,
      ciRepair: {
        start: "ci-cli",
        resume: "ci-cli {sessionref}",
        submitKey: "Shift+Enter",
      },
    },
  });
  const result = await fixture.run();
  assert.match(result.summary.reasons.join(" "), /CI-ready/u);
  assert.equal(fixture.publicationState.creations, 1);
  assert.equal(fixture.publicationState.pushes, 2);
  assert.equal(fixture.repairs.tasks.length, 1);
  assert.match(fixture.repairs.tasks[0]!, /https:\/\/checks\/build\/1/u);
  assert.match(
    fixture.repairs.tasks[0]!,
    /Fixed PR title: feat: \[issue-50\]/u,
  );
  const saved = await fixture.snapshot();
  assert.equal(
    fixture.publicationState.branches.get(saved.branch),
    repairCommit.sha,
  );
  assert.equal(fixture.publicationState.pullRequests[0]!.number, 81);
  assert.equal(fixture.state.closedTabs.length, 2);
  assert.equal(
    fixture.state.submissions.filter(({ text }) => text === "ci-cli").length,
    1,
  );
  assert.deepEqual(fixture.state.sleeps, [10_000, 30_000, 10_000, 30_000]);
  assert.equal(fixture.workspaces.size, 1);
  assert.equal(
    saved.publication!.ciRepair!.attempts[0]!.failedChecks[0]!.link,
    "https://checks/build/1",
  );
  const repairWorkspace = [...fixture.workspaces.values()][0]!;
  assert.notEqual(repairWorkspace.worktree, saved.worktree);
  assert.notEqual(repairWorkspace.branch, saved.branch);
  assert.equal(repairWorkspace.base, saved.result!.commits[0]!.sha);
});

await test("a second CI repair starts fresh from the first repaired remote head", async (t) => {
  const fixture = await ciRepairRun(t);
  const repair = fixture.repairs.onTask;
  fixture.publicationState.onChecks = async () =>
    fixture.publicationState.pushes < 3 ? [failedCheck] : [];
  const second = { sha: "d".repeat(40), message: "fix: remaining check" };
  fixture.repairs.onTask = async (file, evidence) => {
    if (fixture.repairs.tasks.length === 1) return repair(file, evidence);
    evidence.commits = [second];
    evidence.changed = true;
    await publish(file, {
      outcome: "committed",
      summary: "Fixed remaining check",
      commits: [second],
      findings_file: null,
    });
  };
  assert.match((await fixture.run()).summary.reasons.join(" "), /CI-ready/u);
  const budget = (await fixture.snapshot()).publication!.ciRepair!;
  assert.equal(budget.consumed, 2);
  assert.equal(budget.generation, 0);
  assert.equal(budget.attempts[1]!.base, repairCommit.sha);
  assert.notEqual(budget.attempts[0]!.sessionid, budget.attempts[1]!.sessionid);
  assert.deepEqual(
    fixture.publicationState.discoveries,
    [40_000, 80_000, 120_000],
  );
  assert.match((await fixture.run()).summary.reasons.join(" "), /CI-ready/u);
  assert.equal(fixture.publicationState.pushes, 3);
});

await test("CI repair never enters ordinary Review, including after matching-input recovery", async (t) => {
  const fixture = await ciRepairRun(t, {
    ...validConfig,
    workflow: { review: true },
  });
  const probe = fixture.state.onProbe;
  fixture.state.onProbe = async (assignment) => {
    if (assignment.role === "review")
      await publish(String(assignment.path), {
        ...assignment,
        sessionid: "review-session",
      });
    else await probe(assignment);
  };
  let reviews = 0;
  const submit = fixture.dependencies.terminalPlugin.submitText.bind(
    fixture.dependencies.terminalPlugin,
  );
  fixture.dependencies.terminalPlugin.submitText = async (tab, text, chord) => {
    await submit(tab, text, chord);
    if (text.startsWith("Review assignment\n")) {
      reviews++;
      await publish(
        (await fixture.snapshot()).reviews![0]!.invocation!.path,
        passed(),
      );
    }
  };
  assert.match((await fixture.run()).summary.reasons.join(" "), /CI-ready/u);
  assert.equal(reviews, 1);
  assert.match((await fixture.run()).summary.reasons.join(" "), /CI-ready/u);
  assert.equal(reviews, 1);
  assert.equal(fixture.repairs.tasks.length, 1);
  assert.equal(fixture.publicationState.creations, 1);
});

for (const present of [false, true]) {
  await test(`interrupted CI repair processes ${present ? "retained output without a tab" : "missing output by exact native resume and continue"}`, async (t) => {
    const fixture = await ciRepairRun(t);
    const validRepair = fixture.repairs.onTask;
    fixture.repairs.onTask = async (file, evidence) => {
      if (present) await validRepair(file, evidence);
      fixture.controller.abort();
    };
    assert.equal((await fixture.run()).summary.outcome, "cancelled");
    const before = await fixture.snapshot();
    const attempt = before.publication!.ciRepair!.attempts[0]!;
    assert.equal(attempt.sessionid, "ci-session-1");
    assert.equal(attempt.result, undefined);
    fixture.dependencies.signal = new AbortController().signal;
    fixture.repairs.onTask = validRepair;
    const opens = fixture.state.events.filter(
      (event) => event === "open",
    ).length;
    assert.match((await fixture.run()).summary.reasons.join(" "), /CI-ready/u);
    const after = (await fixture.snapshot()).publication!.ciRepair!;
    assert.equal(after.attempts[0]!.attempt_id, attempt.attempt_id);
    assert.equal(after.consumed, 1);
    assert.equal(fixture.repairs.tasks.length, 1);
    assert.equal(fixture.repairs.probes.length, 1);
    assert.equal(
      fixture.state.events.filter((event) => event === "open").length - opens,
      present ? 0 : 1,
    );
    assert.deepEqual(
      fixture.repairs.continuations,
      present ? [] : ["continue"],
    );
    if (!present)
      assert.ok(
        fixture.state.submissions.some(({ text }) =>
          text.includes('--resume "ci-session-1"'),
        ),
      );
  });
}

await test("cancellation after accepting a repair retains its consumed count and does not dispatch another attempt", async (t) => {
  const fixture = await ciRepairRun(t);
  fixture.state.onClose = async () => {
    if (fixture.state.closedTabs.length === 2) fixture.controller.abort();
  };
  assert.equal((await fixture.run()).summary.outcome, "cancelled");
  assert.equal((await fixture.snapshot()).publication!.ciRepair!.consumed, 1);
  fixture.dependencies.signal = new AbortController().signal;
  fixture.state.onClose = async () => {
    /* Cancellation is disabled for recovery. */
  };
  assert.match((await fixture.run()).summary.reasons.join(" "), /CI-ready/u);
  assert.equal(fixture.repairs.tasks.length, 1);
  assert.equal(fixture.publicationState.pushes, 2);
});

await test("failed Git verification consumes an attempt without pushing false claims or correcting the same repair", async (t) => {
  const fixture = await ciRepairRun(t);
  const validRepair = fixture.repairs.onTask;
  fixture.repairs.onTask = async (file, evidence) => {
    await validRepair(file, evidence);
    if (fixture.repairs.tasks.length === 1) evidence.clean = false;
  };
  assert.match((await fixture.run()).summary.reasons.join(" "), /CI-ready/u);
  const budget = (await fixture.snapshot()).publication!.ciRepair!;
  assert.equal(budget.consumed, 2);
  assert.equal(budget.attempts.length, 2);
  assert.match(budget.attempts[0]!.verificationError!, /clean/u);
  assert.equal(budget.attempts[0]!.corrections, 0);
  assert.equal(budget.attempts[1]!.pushed, true);
  assert.equal(fixture.publicationState.pushes, 2);
  assert.equal(fixture.repairs.probes.length, 2);
});

await test("operator retry rechecks CI before authorizing a fresh two-attempt generation", async (t) => {
  const fixture = await ciRepairRun(t);
  const validRepair = fixture.repairs.onTask;
  fixture.repairs.onTask = async (file, evidence) => {
    if (fixture.repairs.tasks.length > 2) return validRepair(file, evidence);
    await publish(file, {
      outcome: "no_change",
      summary: "No repair",
      commits: [],
      findings_file: null,
    });
  };
  let pauses = 0;
  fixture.dependencies.operator.pause = async (message) => {
    assert.match(message, /CI repair failed after two attempts/u);
    pauses++;
    return "";
  };
  assert.match((await fixture.run()).summary.reasons.join(" "), /CI-ready/u);
  const budget = (await fixture.snapshot()).publication!.ciRepair!;
  assert.equal(pauses, 1);
  assert.equal(budget.consumed, 1);
  assert.equal(budget.generation, 1);
  assert.deepEqual(
    budget.attempts.map(({ generation }) => generation),
    [0, 0, 1],
  );
});

await test("a repair push with a lost response reconciles its pending evidence without pushing twice", async (t) => {
  const fixture = await ciRepairRun(t);
  const push = fixture.publicationState.onPush;
  fixture.publicationState.onPush = async (branch, head) => {
    await push(branch, head);
    if (head === repairCommit.sha) throw new Error("repair push response lost");
  };
  assert.match((await fixture.run()).summary.reasons.join(" "), /CI-ready/u);
  assert.equal(fixture.publicationState.pushes, 2);
  assert.equal(fixture.dependencies.pauses.length, 0);
  assert.equal((await fixture.snapshot()).publication!.ciRepair!.consumed, 1);
});

await test("an interrupted repair push resumes from its verified pending evidence", async (t) => {
  const fixture = await ciRepairRun(t);
  const push = fixture.publicationState.onPush;
  fixture.publicationState.onPush = async (branch, head) => {
    await push(branch, head);
    if (head === repairCommit.sha) fixture.controller.abort();
  };
  assert.equal((await fixture.run()).summary.outcome, "cancelled");
  const before = await fixture.snapshot();
  assert.equal(
    before.publication!.ciRepair!.attempts[0]!.pendingPush,
    repairCommit.sha,
  );
  fixture.dependencies.signal = new AbortController().signal;
  fixture.dependencies.operator.pause = async () => "q";
  const result = await fixture.run();
  assert.match(result.summary.reasons.join(" "), /CI-ready/u);
  assert.equal(fixture.publicationState.pushes, 2);
  assert.equal(fixture.repairs.tasks.length, 1);
  const saved = await fixture.snapshot();
  assert.equal(saved.publication!.ciRepair!.consumed, 1);
  assert.equal(saved.publication!.ciRepair!.attempts[0]!.pushed, true);
});

await test("two no_change repairs exhaust the independent CI budget and require operator authorization", async (t) => {
  const fixture = await ciRepairRun(t);
  fixture.repairs.onTask = async (file) => {
    if (fixture.repairs.tasks.length > 2) fixture.controller.abort();
    await publish(file, {
      outcome: "no_change",
      summary: "No local repair",
      commits: [],
      findings_file: null,
    });
  };
  fixture.dependencies.operator.pause = async (message) => {
    assert.match(message, /CI repair failed after two attempts/u);
    return "q";
  };
  assert.equal((await fixture.run()).summary.outcome, "cancelled");
  assert.equal(fixture.repairs.tasks.length, 2);
  const budget = (await fixture.snapshot()).publication!.ciRepair!;
  assert.equal(budget.consumed, 2);
  assert.equal(budget.generation, 0);
  assert.equal(budget.attempts.length, 2);
  assert.equal(fixture.publicationState.pushes, 1);
});
