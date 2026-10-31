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
        async getRemoteBranchHead() {
          return remote;
        },
        async listPullRequests() {
          return pullRequests;
        },
        async createPullRequest(input) {
          assert.equal(remote, implementationCommit.sha);
          effects.push("create");
          created = input;
          pullRequests.push({
            number: 81,
            url: "https://github.com/owner/repo/pull/81",
            branch: input.branch,
            targetBranch: input.targetBranch,
            headSha: remote,
            state: "open",
          });
          return { number: 81, url: "https://github.com/owner/repo/pull/81" };
        },
        async getRequiredChecks() {
          assert.equal(fixture.state.sleeps.at(-1), 30_000);
          effects.push("checks");
          return [];
        },
      },
    },
  );
  assert.deepEqual(effects, ["push", "create", "checks"]);
  const saved = await fixture.snapshot();
  assert.deepEqual(created, {
    repository: "owner/repo",
    targetBranch: "default-branch",
    branch: saved.branch,
    title: "feat: [issue-50] implement the Issue",
    body: "Implement the Issue.\n\nCloses #50",
  });
  assert.equal(result.summary.outcome, "incomplete");
  assert.match(result.summary.reasons.join(" "), /CI-ready.*retained/u);
  assert.equal(fixture.state.ticket.state, "open");
  assert.ok(fixture.state.ticket.assignees!.length > 0);
  await access(saved.worktree);
  await access(saved.invocation!.path);
  await access(saved.probe!.path);
  assert.equal(fixture.state.closedTabs.length, 1);
  assert.equal(saved.publication?.phase, "checks_ready");
  assert.equal(saved.publication.pullRequest?.number, 81);
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
    assert.match(result.summary.reasons.join(" "), /CI-ready/u);
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
  assert.match(result.summary.reasons.join(" "), /CI-ready/u);
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
  assert.match((await fixture.run()).summary.reasons.join(" "), /CI-ready/u);
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
      if (options.label.includes("ci_repair")) fixture.controller.abort();
      return open(options);
    };
    const result = await fixture.run();
    assert.equal(result.summary.outcome, "cancelled");
    assert.doesNotMatch(result.summary.reasons.join(" "), /CI-ready/u);
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

await test("lost Issue eligibility after push stops publication without a PR or an Operator Pause", async (t) => {
  const fixture = await publicationRun(t);
  fixture.publicationState.onPush = async (branch, head) => {
    fixture.publicationState.branches.set(branch, head);
    fixture.state.ticket.assignees!.push("someone-else");
  };
  const result = await fixture.run();
  assert.equal(result.summary.outcome, "incomplete", JSON.stringify(result));
  assert.match(result.summary.reasons.join(" "), /externally owned/u);
  assert.equal(fixture.publicationState.creations, 0);
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
  assert.match((await fixture.run()).summary.reasons.join(" "), /CI-ready/u);
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
