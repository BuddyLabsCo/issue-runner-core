/* eslint-disable @typescript-eslint/require-await -- Scripted external boundaries. */
import assert from "node:assert/strict";
import { access } from "node:fs/promises";
import test from "node:test";
import { executeCli } from "../../src/cli.ts";
import { implementationCommand } from "../support/implementation-run.ts";
import { integrationRun } from "../support/integration-run.ts";
import { publicationRun } from "../support/publication-run.ts";

for (const interruption of [
  "intent",
  "push",
  "pushed",
  "creation",
  "observation",
] as const) {
  await test(`restart after publication ${interruption} continues the recorded delivery without replaying confirmed effects`, async (t) => {
    const fixture = await publicationRun(t);
    const state = fixture.publicationState;
    const push = fixture.dependencies.gitWorkspace.push.bind(
      fixture.dependencies.gitWorkspace,
    );
    const onPush = state.onPush;
    const onCreate = state.onCreate;
    const onChecks = state.onChecks;
    const list = fixture.dependencies.codeHost.listPullRequests.bind(
      fixture.dependencies.codeHost,
    );
    if (interruption === "intent")
      fixture.dependencies.gitWorkspace.push = async () =>
        fixture.controller.abort();
    else if (interruption === "push")
      state.onPush = async (branch, head) => {
        await onPush(branch, head);
        fixture.controller.abort();
      };
    else if (interruption === "pushed")
      fixture.dependencies.codeHost.listPullRequests = async () => {
        fixture.controller.abort();
        return [];
      };
    else if (interruption === "creation")
      state.onCreate = async () => fixture.controller.abort();
    else
      state.onChecks = async () => {
        fixture.controller.abort();
        return [];
      };
    assert.equal((await fixture.run()).summary.outcome, "cancelled");
    const before = await fixture.snapshot();
    assert.equal(
      before.publication!.phase,
      interruption === "intent" || interruption === "push"
        ? "pending_push"
        : interruption === "pushed"
          ? "pushed"
          : interruption === "creation"
            ? "pending_pr"
            : "pr_created",
    );
    assert.equal(state.pushes, interruption === "intent" ? 0 : 1);
    assert.equal(
      state.creations,
      interruption === "creation" || interruption === "observation" ? 1 : 0,
    );
    const submissions = fixture.state.submissions.length;
    fixture.dependencies.signal = new AbortController().signal;
    fixture.dependencies.gitWorkspace.push = push;
    state.onPush = onPush;
    state.onCreate = onCreate;
    state.onChecks = onChecks;
    fixture.dependencies.codeHost.listPullRequests = list;
    const result = await fixture.run();
    assert.match(result.summary.reasons.join(" "), /CI-ready/u);
    assert.equal(state.pushes, 1);
    assert.equal(state.creations, 1);
    assert.equal(fixture.state.taskCount, 1);
    assert.equal(fixture.state.probeCount, 1);
    assert.equal(fixture.state.submissions.length, submissions);
    const after = await fixture.snapshot();
    assert.equal(after.execution_id, before.execution_id);
    assert.equal(after.worktree, before.worktree);
    assert.deepEqual(after.roles, before.roles);
    assert.deepEqual(after.probe, before.probe);
    assert.deepEqual(after.invocation, before.invocation);
    assert.equal(after.pr_title, before.pr_title);
    assert.equal(after.pr_body, before.pr_body);
    assert.equal(after.publication!.phase, "checks_ready");
    if (interruption === "observation") {
      assert.equal(
        after.publication!.discoveryNotBefore,
        before.publication!.discoveryNotBefore,
      );
      assert.equal(
        after.publication!.checksDeadline,
        before.publication!.checksDeadline,
      );
    }
    await access(after.worktree);
    await access(after.probe!.path);
    await access(after.invocation!.path);
    assert.equal(fixture.dependencies.pauses.length, 0);
  });
}

await test("restart pauses before retrying an uncertain PR creation with no exact remote match", async (t) => {
  const fixture = await publicationRun(t);
  const create = fixture.dependencies.codeHost.createPullRequest.bind(
    fixture.dependencies.codeHost,
  );
  fixture.dependencies.codeHost.createPullRequest = async () => {
    fixture.controller.abort();
    throw new Error("creation interrupted without a response");
  };
  assert.equal((await fixture.run()).summary.outcome, "cancelled");
  const before = await fixture.snapshot();
  assert.equal(before.publication!.creationAttempted, true);
  assert.equal(before.publication!.phase, "pending_pr");
  fixture.dependencies.codeHost.createPullRequest = create;
  fixture.dependencies.signal = new AbortController().signal;
  let pauses = 0;
  fixture.dependencies.operator.pause = async (message) => {
    assert.match(message, /creation outcome is uncertain/u);
    assert.equal(fixture.publicationState.creations, 0);
    pauses++;
    return "";
  };
  assert.match((await fixture.run()).summary.reasons.join(" "), /CI-ready/u);
  assert.equal(pauses, 1);
  assert.equal(fixture.publicationState.pushes, 1);
  assert.equal(fixture.publicationState.creations, 1);
  assert.equal(fixture.state.taskCount, 1);
  assert.equal(fixture.state.probeCount, 1);
});

for (const conflict of [
  "advanced",
  "absent",
  "number",
  "url",
  "duplicate",
  "closed",
  "draft",
  "missing",
] as const) {
  await test(`restart pauses on ${conflict} remote evidence without replacing the recorded publication`, async (t) => {
    const fixture = await publicationRun(t);
    const state = fixture.publicationState;
    fixture.state.onSleep = async (ms) => {
      if (ms === 30_000) fixture.controller.abort();
    };
    assert.equal((await fixture.run()).summary.outcome, "cancelled");
    const before = await fixture.snapshot();
    assert.equal(before.publication!.phase, "pr_created");
    const record = state.pullRequests[0]!;
    if (conflict === "advanced")
      state.branches.set(before.branch, "d".repeat(40));
    else if (conflict === "absent") state.branches.delete(before.branch);
    else if (conflict === "number") record.number = 999;
    else if (conflict === "url")
      record.url = "https://github.com/owner/repo/pull/999";
    else if (conflict === "duplicate")
      state.pullRequests.push({ ...record, number: 999 });
    else if (conflict === "closed") record.state = "closed";
    else if (conflict === "draft") record.draft = true;
    else state.pullRequests.length = 0;
    fixture.dependencies.signal = new AbortController().signal;
    let pauses = 0;
    fixture.dependencies.operator.pause = async (message) => {
      assert.match(
        message,
        conflict === "advanced" || conflict === "absent"
          ? /advanced or disappeared/u
          : conflict === "missing"
            ? /Recorded Pull Request is missing/u
            : /identity or head mismatch/u,
      );
      pauses++;
      return "q";
    };
    assert.equal((await fixture.run()).summary.outcome, "cancelled");
    assert.equal(pauses, 1);
    assert.equal(state.pushes, 1);
    assert.equal(state.creations, 1);
    assert.equal(state.discoveries.length, 0);
    assert.equal(fixture.state.taskCount, 1);
    assert.equal(fixture.state.probeCount, 1);
    assert.deepEqual(
      (await fixture.snapshot()).publication!.pullRequest,
      before.publication!.pullRequest,
    );
    await access(before.worktree);
    await access(before.invocation!.path);
  });
}

for (const closure of ["runner", "code_host", "no_auto_merge"] as const) {
  await test(`restart adopts an exact merged PR with ${closure} closure without repeating Agent or publication work`, async (t) => {
    const fixture = await integrationRun(t);
    const run =
      closure === "no_auto_merge"
        ? () => executeCli(implementationCommand, fixture.dependencies)
        : fixture.run;
    const state = fixture.publicationState;
    state.onCreate = async () => fixture.controller.abort();
    assert.equal((await run()).summary.outcome, "cancelled");
    const before = await fixture.snapshot();
    assert.equal(before.publication!.phase, "pending_pr");
    assert.equal(before.publication!.pullRequest, undefined);
    state.pullRequests[0]!.state = "merged";
    fixture.integrationState.pullRequest.merged = true;
    if (closure !== "runner") {
      fixture.state.ticket.state = "closed";
      fixture.state.ticket.stateReason = "completed";
      state.branches.delete(before.branch);
    }
    fixture.dependencies.signal = new AbortController().signal;
    const result = await run();
    assert.equal(result.summary.outcome, "succeeded", JSON.stringify(result));
    assert.equal(state.pushes, 1);
    assert.equal(state.creations, 1);
    assert.equal(state.discoveries.length, 0);
    assert.equal(fixture.state.taskCount, 1);
    assert.equal(fixture.state.probeCount, 1);
    assert.equal(fixture.integrationState.requests.length, 0);
    assert.equal(
      fixture.integrationState.closures,
      closure === "runner" ? 1 : 0,
    );
    const after = await fixture.snapshot();
    assert.equal(after.pr_title, before.pr_title);
    assert.equal(after.pr_body, before.pr_body);
    assert.equal(after.publication!.phase, "delivered");
    assert.equal(fixture.state.cleanup.length, 1);
    assert.equal(fixture.state.cleanup[0]!.worktree, before.worktree);
    await assert.rejects(access(before.probe!.path));
    await assert.rejects(access(before.invocation!.path));
  });
}

for (const conflict of ["unmerged", "head", "advanced", "identity"] as const) {
  await test(`a completed tracker Issue with ${conflict} merge evidence cannot earn delivery credit on restart`, async (t) => {
    const fixture = await integrationRun(t);
    const state = fixture.publicationState;
    state.onCreate = async () => fixture.controller.abort();
    assert.equal((await fixture.run()).summary.outcome, "cancelled");
    const before = await fixture.snapshot();
    const record = state.pullRequests[0]!;
    record.state = conflict === "unmerged" ? "open" : "merged";
    fixture.integrationState.pullRequest.merged = conflict !== "unmerged";
    if (conflict === "head")
      fixture.integrationState.pullRequest.headSha = "d".repeat(40);
    if (conflict === "advanced")
      state.branches.set(before.branch, "d".repeat(40));
    if (conflict === "identity") record.targetBranch = "unrelated";
    fixture.state.ticket.state = "closed";
    fixture.state.ticket.stateReason = "completed";
    fixture.dependencies.signal = new AbortController().signal;
    let pauses = 0;
    fixture.dependencies.operator.pause = async (message) => {
      assert.match(
        message,
        /merge does not match|advanced after merge|identity or head mismatch/u,
      );
      pauses++;
      return "q";
    };
    const result = await fixture.run();
    assert.equal(
      result.summary.outcome,
      conflict === "unmerged" ? "incomplete" : "cancelled",
      JSON.stringify(result),
    );
    assert.equal(pauses, conflict === "unmerged" ? 0 : 1);
    assert.equal(state.pushes, 1);
    assert.equal(state.creations, 1);
    assert.equal(state.discoveries.length, 0);
    assert.equal(fixture.integrationState.requests.length, 0);
    assert.equal(fixture.integrationState.closures, 0);
    assert.equal(fixture.state.cleanup.length, 0);
    assert.equal(fixture.state.taskCount, 1);
    assert.equal(fixture.state.probeCount, 1);
    assert.equal((await fixture.snapshot()).publication!.phase, "pending_pr");
    await access(before.worktree);
    await access(before.probe!.path);
    await access(before.invocation!.path);
  });
}
