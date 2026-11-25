/* eslint-disable @typescript-eslint/require-await -- Scripted external boundaries. */
import assert from "node:assert/strict";
import { access, rename } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { executeCli } from "../../src/cli.ts";
import type { PullRequestRecord } from "../../src/run/contracts.ts";
import { publicationRun } from "../support/publication-run.ts";
import { validConfig } from "../support/cli-project.ts";
import {
  implementationCommand,
  implementationCommit,
  implementationRun,
} from "../support/implementation-run.ts";

await test("no-auto-merge publishes fixed Probe metadata, waits for checks, and retains unmerged resources without delivery credit", async (t) => {
  const fixture = await implementationRun(t);
  const effects: string[] = [];
  let remote: string | null = null;
  let created: unknown;
  const pullRequests: PullRequestRecord[] = [];
  const result = await executeCli(
    [...implementationCommand, "--no-auto-merge"],
    {
      ...fixture.dependencies,
      gitWorkspace: {
        ...fixture.dependencies.gitWorkspace,
        async push() {
          const saved = await fixture.snapshot();
          assert.ok(saved.pr_title);
          effects.push("push");
          remote = implementationCommit.sha;
        },
      },
      codeHost: {
        ...fixture.dependencies.codeHost,
        async observeBranch() {
          return { repositoryId: "R_repo", headSha: remote };
        },
        async observePublication() {
          return {
            repositoryId: "R_repo",
            headSha: remote,
            candidates: pullRequests,
          };
        },
        async createPullRequest(input) {
          assert.equal(remote, implementationCommit.sha);
          effects.push("create");
          created = input;
          const record: PullRequestRecord = {
            id: "PR_81",
            number: 81,
            url: "https://github.com/owner/repo/pull/81",
            createdAt: "2026-10-30T00:00:00Z",
            branch: input.branch,
            targetBranch: input.targetBranch,
            headSha: remote,
            state: "open",
            draft: false,
          };
          pullRequests.push(record);
          return record;
        },
        async observePullRequest(input) {
          assert.equal(input.number, 81);
          assert.equal(fixture.state.sleeps.at(-1), 30_000);
          effects.push("checks");
          const record = pullRequests[0]!;
          return {
            branch: { repositoryId: "R_repo", headSha: remote },
            pullRequest: record,
            lastCommitSha: record.headSha,
            merge: {
              headSha: record.headSha,
              createdAt: record.createdAt,
              merged: false,
              mergeRequested: false,
              mergeable: "unknown",
              mergeFailure: null,
              mergeStateStatus: "UNKNOWN",
              isInMergeQueue: false,
              isMergeQueueEnabled: false,
              autoMergeEnabledAt: null,
              mergeQueueEntryId: null,
            },
            checks: [],
          };
        },
      },
    },
  );
  assert.deepEqual(effects, ["push", "create", "checks"]);
  const saved = await fixture.snapshot();
  assert.deepEqual(created, {
    repository: "owner/repo",
    repositoryId: "R_repo",
    targetBranch: "default-branch",
    branch: saved.branch,
    title: "feat: [issue-50] implement the Issue",
    body: "Implement the Issue.\n\nCloses #50",
  });
  assert.equal(result.summary.outcome, "incomplete");
  assert.match(result.summary.tickets![0]!.detail, /CI-ready.*retained/u);
  assert.equal(fixture.state.ticket.state, "open");
  assert.ok(fixture.state.ticket.assignees!.length > 0);
  await access(saved.worktree);
  await access(saved.invocation!.path);
  await access(saved.probe!.path);
  assert.equal(fixture.state.closedTabs.length, 1);
  assert.equal(fixture.state.manualTabs.length, 1);
  const manual = fixture.state.manualTabs[0]!;
  assert.equal(manual.options.cwd, saved.worktree);
  assert.deepEqual(manual.commands, [saved.roles.implement!.resume]);
  assert.equal(
    fixture.state.submissions.some(({ tab }) => tab === manual.handle),
    false,
  );
  assert.equal(saved.publication?.phase, "checks_ready");
  assert.equal(saved.publication.pullRequest?.number, 81);
});

await test("cancellation during push reopens the completed implementation for manual takeover", async (t) => {
  const fixture = await publicationRun(t);
  fixture.publicationState.onPush = async () => fixture.controller.abort();
  assert.equal((await fixture.run()).summary.outcome, "cancelled");
  const saved = await fixture.snapshot();
  assert.equal(fixture.state.closedTabs.length, 1);
  assert.equal(fixture.state.manualTabs.length, 1);
  assert.deepEqual(fixture.state.manualTabs[0]!.commands, [
    saved.roles.implement!.resume,
  ]);
  assert.equal(fixture.state.manualTabs[0]!.options.cwd, saved.worktree);
  assert.equal(
    fixture.state.manualTabs[0]!.options.signal?.aborted ?? false,
    false,
  );
});

await test("publication failure reopens the completed implementation without replacing the failure", async (t) => {
  const fixture = await publicationRun(t);
  fixture.state.onSleep = async (ms) => {
    if (ms === 30_000) throw new Error("discovery failed");
  };
  const result = await fixture.run();
  assert.equal(result.summary.outcome, "failed");
  assert.match(result.summary.failure!, /discovery failed/u);
  assert.deepEqual(fixture.state.manualTabs[0]!.commands, [
    (await fixture.snapshot()).roles.implement!.resume,
  ]);
});

await test("cancellation before implementation acceptance does not open a manual tab", async (t) => {
  const fixture = await publicationRun(t);
  fixture.state.onTask = async () => fixture.controller.abort();
  assert.equal((await fixture.run()).summary.outcome, "cancelled");
  assert.equal(fixture.state.manualTabs.length, 0);
});

await test("failure to reopen the manual tab does not change the publication outcome", async (t) => {
  const fixture = await publicationRun(t);
  const create = fixture.dependencies.terminalPlugin.createTab.bind(
    fixture.dependencies.terminalPlugin,
  );
  fixture.dependencies.terminalPlugin.createTab = async (options) => {
    if (options.label.endsWith(" (manual)"))
      throw new Error("terminal unavailable");
    return create(options);
  };
  const result = await fixture.run();
  assert.equal(result.summary.outcome, "incomplete");
  assert.ok(
    fixture.dependencies.messages.some((message) =>
      message.includes("Unable to reopen implement tab: terminal unavailable"),
    ),
  );
});

for (const lost of ["push", "create"] as const) {
  await test(`a lost ${lost} response reconciles recorded evidence without repeating the completed write`, async (t) => {
    const fixture = await publicationRun(t);
    const state = fixture.publicationState;
    if (lost === "push") {
      state.onPush = async (branch, head) => {
        state.branches.set(branch, head);
        throw new Error("push response lost");
      };
    } else
      state.onCreate = async () => {
        throw new Error("PR response lost");
      };
    const result = await fixture.run();
    assert.equal(result.summary.outcome, "incomplete", JSON.stringify(result));
    assert.match(result.summary.tickets![0]!.detail, /CI-ready/u);
    assert.equal(state.pushes, 1);
    assert.equal(state.creations, 1);
    assert.equal(
      (await fixture.snapshot()).publication?.pullRequest?.number,
      81,
    );
    assert.equal(fixture.dependencies.pauses.length, 0);
  });
}

await test("uncertain PR creation with no exact match requires operator authorization before a second create", async (t) => {
  const fixture = await publicationRun(t);
  const state = fixture.publicationState;
  state.onCreate = async () => {
    state.pullRequests.length = 0;
    throw new Error("unknown creation outcome");
  };
  fixture.dependencies.operator.pause = async (message) => {
    assert.match(
      message,
      /\[Operator Pause\] Issue #50 .*publication pending_pr/u,
    );
    assert.match(message, /creation outcome is uncertain/u);
    assert.equal(state.creations, 1);
    return "q";
  };
  assert.equal((await fixture.run()).summary.outcome, "cancelled");
  assert.equal(state.creations, 1);
  assert.equal((await fixture.snapshot()).publication?.phase, "pending_pr");
});

for (const mismatch of [
  "branch",
  "targetBranch",
  "headSha",
  "duplicate",
  "closed",
  "draft",
] as const) {
  await test(`a ${mismatch} PR mismatch pauses without creating a replacement`, async (t) => {
    const fixture = await publicationRun(t);
    const state = fixture.publicationState;
    state.onCreate = async () => {
      const record = state.pullRequests[0]!;
      if (mismatch === "duplicate")
        state.pullRequests.push({ ...record, number: 99 });
      else if (mismatch === "closed") record.state = "closed";
      else if (mismatch === "draft") record.draft = true;
      else record[mismatch] = "unexpected";
      throw new Error("response lost");
    };
    fixture.dependencies.operator.pause = async (message) => {
      assert.match(message, /identity or head mismatch/u);
      return "q";
    };
    assert.equal((await fixture.run()).summary.outcome, "cancelled");
    assert.equal(state.creations, 1);
    assert.equal(state.discoveries.length, 0);
  });
}

await test("remote advancement after an uncertain push is retained without a second push or PR", async (t) => {
  const fixture = await publicationRun(t);
  const state = fixture.publicationState;
  state.onPush = async (branch) => {
    state.branches.set(branch, "d".repeat(40));
    throw new Error("lost response");
  };
  fixture.dependencies.operator.pause = async (message) => {
    assert.match(message, /advanced or disappeared/u);
    return "q";
  };
  assert.equal((await fixture.run()).summary.outcome, "cancelled");
  assert.equal(state.pushes, 1);
  assert.equal(state.creations, 0);
});

await test("changed local work after the completed tab closes cannot be pushed", async (t) => {
  const fixture = await publicationRun(t);
  fixture.state.onClose = async () => {
    fixture.state.evidence.clean = false;
  };
  fixture.dependencies.operator.pause = async (message) => {
    assert.match(message, /Worktree must be clean/u);
    return "q";
  };
  assert.equal((await fixture.run()).summary.outcome, "cancelled");
  assert.equal(fixture.publicationState.pushes, 0);
});

await test("required checks wait 30 seconds for discovery, then poll pending checks until all pass", async (t) => {
  const fixture = await publicationRun(t);
  let calls = 0;
  fixture.publicationState.onChecks = async () => [
    {
      name: "test",
      state: ++calls === 1 ? "IN_PROGRESS" : "SUCCESS",
      link: "https://checks/1",
      bucket: calls === 1 ? "pending" : "pass",
    },
  ];
  const result = await fixture.run();
  assert.match(result.summary.tickets![0]!.detail, /CI-ready/u);
  assert.deepEqual(fixture.publicationState.discoveries, [40_000, 50_000]);
  assert.deepEqual(fixture.state.sleeps, [10_000, 30_000, 10_000]);
  assert.equal(
    (await fixture.snapshot()).publication?.checks?.[0]?.bucket,
    "pass",
  );
});

await test("required-check timeout uses configured minutes and operator retry without another creation", async (t) => {
  const fixture = await publicationRun(t, {
    ...validConfig,
    timeouts: { ...validConfig.timeouts, requiredChecksMinutes: 0.25 },
  });
  fixture.publicationState.checks = [
    { name: "build", state: "PENDING", link: "", bucket: "pending" },
  ];
  fixture.dependencies.operator.pause = async (message) => {
    assert.match(message, /Required checks timed out/u);
    fixture.publicationState.checks[0]!.bucket = "pass";
    return "";
  };
  assert.match((await fixture.run()).summary.tickets![0]!.detail, /CI-ready/u);
  assert.deepEqual(fixture.state.sleeps, [10_000, 30_000, 10_000, 5_000]);
  assert.equal(fixture.publicationState.creations, 1);
});

for (const bucket of ["fail", "cancel"] as const) {
  await test(`${bucket} checks retain their evidence when cancellation stops repair startup`, async (t) => {
    const fixture = await publicationRun(t);
    fixture.publicationState.checks = [
      { name: "test", state: "FAILURE", link: "", bucket },
    ];
    const open = fixture.dependencies.terminalPlugin.createTab.bind(
      fixture.dependencies.terminalPlugin,
    );
    fixture.dependencies.terminalPlugin.createTab = async (options) => {
      if (options.label.includes("ci repair")) fixture.controller.abort();
      return open(options);
    };
    const result = await fixture.run();
    assert.equal(result.summary.outcome, "cancelled");
    assert.doesNotMatch(result.summary.tickets![0]!.detail, /CI-ready/u);
    const saved = await fixture.snapshot();
    assert.equal(saved.publication?.phase, "checks_failed");
    assert.equal(saved.publication.checks?.[0]?.bucket, bucket);
    await access(saved.worktree);
  });
}

await test("cancellation during discovery delay retains PR identity and prevents check discovery", async (t) => {
  const fixture = await publicationRun(t);
  fixture.state.onSleep = async (ms) => {
    if (ms === 30_000) fixture.controller.abort();
  };
  assert.equal((await fixture.run()).summary.outcome, "cancelled");
  assert.equal(fixture.publicationState.discoveries.length, 0);
  const saved = await fixture.snapshot();
  assert.equal(saved.publication?.pullRequest?.number, 81);
  assert.equal(saved.publication.phase, "pr_created");
  assert.ok(saved.publication.discoveryNotBefore);
});

await test("publication after push uses branch and PR evidence without reading Issue eligibility", async (t) => {
  const fixture = await publicationRun(t);
  const { tracker } = fixture.dependencies;
  const getTicket = tracker.getTicket.bind(tracker);
  let pushed = false;
  let eligibilityReads = 0;
  tracker.getTicket = async () => {
    if (pushed) eligibilityReads++;
    return getTicket();
  };
  fixture.publicationState.onPush = async (branch, head) => {
    fixture.publicationState.branches.set(branch, head);
    pushed = true;
  };
  const result = await fixture.run();
  assert.equal(result.summary.outcome, "incomplete", JSON.stringify(result));
  assert.match(result.summary.tickets![0]!.detail, /CI-ready/u);
  assert.equal(fixture.publicationState.creations, 1);
  assert.equal(eligibilityReads, 0);
  assert.equal(fixture.dependencies.pauses.length, 0);
});

await test("an audit failure after PR creation retries only the log append", async (t) => {
  const fixture = await publicationRun(t);
  const logs = path.join(fixture.directory, "logs");
  const retained = path.join(fixture.directory, "logs-retained");
  fixture.publicationState.onCreate = async () => {
    await rename(logs, retained);
  };
  let pauses = 0;
  fixture.dependencies.operator.pause = async (message) => {
    assert.match(message, /Audit write failed/u);
    pauses++;
    await rename(retained, logs);
    return "";
  };
  assert.match((await fixture.run()).summary.tickets![0]!.detail, /CI-ready/u);
  assert.equal(pauses, 1);
  assert.equal(fixture.publicationState.creations, 1);
});

await test("an existing remote head cannot be adopted without recorded publication intent", async (t) => {
  const fixture = await publicationRun(t);
  fixture.state.onClose = async () => {
    const saved = await fixture.snapshot();
    fixture.publicationState.branches.set(
      saved.branch,
      implementationCommit.sha,
    );
  };
  fixture.dependencies.operator.pause = async (message) => {
    assert.match(message, /without recorded publication intent/u);
    return "q";
  };
  assert.equal((await fixture.run()).summary.outcome, "cancelled");
  assert.equal(fixture.publicationState.pushes, 0);
  assert.equal(fixture.publicationState.creations, 0);
  assert.equal((await fixture.snapshot()).publication, undefined);
});

await test("a closed Pull Request on another source with the exact base and head prevents creation", async (t) => {
  const fixture = await publicationRun(t);
  const state = fixture.publicationState;
  state.onPush = async (branch, headSha) => {
    state.branches.set(branch, headSha);
    state.pullRequests.push({
      id: "PR_closed",
      number: 80,
      url: "https://github.com/owner/repo/pull/80",
      createdAt: "2026-10-30T00:00:00Z",
      branch: "another-source",
      targetBranch: "default-branch",
      headSha,
      state: "closed",
      draft: false,
    });
  };
  fixture.dependencies.operator.pause = async (message) => {
    assert.match(message, /identity or head mismatch/u);
    return "q";
  };
  assert.equal((await fixture.run()).summary.outcome, "cancelled");
  assert.equal(state.pushes, 1);
  assert.equal(state.creations, 0);
});

await test("a PR created with an unexpected head is never checkpointed as successful", async (t) => {
  const fixture = await publicationRun(t);
  const state = fixture.publicationState;
  state.onCreate = async () => {
    state.pullRequests[0]!.headSha = "d".repeat(40);
  };
  fixture.dependencies.operator.pause = async (message) => {
    assert.match(message, /identity or head mismatch/u);
    return "q";
  };
  assert.equal((await fixture.run()).summary.outcome, "cancelled");
  const saved = (await fixture.snapshot()).publication!;
  assert.equal(saved.phase, "pending_pr");
  assert.equal(saved.pullRequest, undefined);
  assert.equal(state.creations, 1);
  assert.deepEqual(state.discoveries, []);
});

await test("a Pull Request that appears during the Operator Pause prevents a second create", async (t) => {
  const fixture = await publicationRun(t);
  const state = fixture.publicationState;
  let delayed: PullRequestRecord | undefined;
  state.onCreate = async () => {
    delayed = state.pullRequests.pop();
    throw new Error("response lost before Pull Request became visible");
  };
  fixture.dependencies.operator.pause = async (message) => {
    assert.match(message, /creation outcome is uncertain/u);
    state.pullRequests.push(delayed!);
    return "";
  };
  const result = await fixture.run();
  assert.match(result.summary.tickets![0]!.detail, /CI-ready/u);
  assert.equal(state.creations, 1);
  assert.equal(
    (await fixture.snapshot()).publication?.pullRequest?.id,
    "PR_81",
  );
});
