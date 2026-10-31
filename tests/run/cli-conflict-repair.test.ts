/* eslint-disable @typescript-eslint/require-await -- Scripted external boundaries. */
import assert from "node:assert/strict";
import test from "node:test";
import { readFile, readdir, writeFile } from "node:fs/promises";
import path from "node:path";
import type { GitWorkspace } from "../../src/run/contracts.ts";
import { executeCli } from "../../src/cli.ts";
import { repairCommit, failedCheck } from "../support/ci-repair-run.ts";
import { validConfig } from "../support/cli-project.ts";
import { conflictRepairRun } from "../support/conflict-repair-run.ts";
import { publish } from "../support/implementation-run.ts";
import {
  deliveryCommand as implementationCommand,
  implementationCommit,
} from "../support/implementation-run.ts";

await test("explicit merge conflict repairs the existing PR and waits for checks before integrating its verified head", async (t) => {
  const fixture = await conflictRepairRun(t);
  const result = await executeCli(implementationCommand, fixture.dependencies);
  assert.equal(result.summary.outcome, "succeeded", JSON.stringify(result));
  const saved = await fixture.snapshot();
  assert.equal(saved.publication!.conflictRepair!.consumed, 1);
  assert.deepEqual(
    fixture.conflictState.requests.map(({ headSha }) => headSha),
    [implementationCommit.sha, repairCommit.sha],
  );
  assert.equal(saved.publication!.ciRepair, undefined);
  assert.equal(saved.publication!.merge!.headSha, repairCommit.sha);
  assert.equal(saved.publication!.title, saved.pr_title);
  assert.equal(saved.publication!.body, saved.pr_body);
  assert.equal(fixture.publicationState.creations, 1);
  assert.equal(fixture.publicationState.pushes, 2);
  assert.equal(fixture.repairs.probes.length, 1);
  assert.equal(fixture.repairs.tasks.length, 1);
  assert.match(fixture.repairs.tasks[0]!, /Merge conflict in README/u);
  assert.match(fixture.repairs.tasks[0]!, /Target Branch SHA: a{40}/u);
  assert.deepEqual(fixture.state.sleeps, [10_000, 30_000, 10_000, 30_000]);
});

await test("explicit conflicting state starts repair without attempting a rejected merge", async (t) => {
  const fixture = await conflictRepairRun(t);
  fixture.conflictState.mergeable = "conflicting";
  const repair = fixture.repairs.onTask;
  fixture.repairs.onTask = async (file, evidence) => {
    assert.equal(fixture.conflictState.requests.length, 0);
    await repair(file, evidence);
    fixture.conflictState.mergeable = "mergeable";
  };
  assert.equal((await fixture.run()).summary.outcome, "succeeded");
  assert.equal(fixture.conflictState.requests.length, 1);
});

await test("two unsuccessful conflict attempts remain exhausted across restart until authorized", async (t) => {
  const fixture = await conflictRepairRun(t);
  fixture.repairs.onTask = async (file) =>
    publish(file, {
      outcome: "no_change",
      summary: "No repair",
      commits: [],
      findings_file: null,
    });
  fixture.dependencies.operator.pause = async (message) => {
    assert.match(message, /Conflict repair failed after two attempts/u);
    return "q";
  };
  assert.equal((await fixture.run()).summary.outcome, "cancelled");
  fixture.dependencies.signal = new AbortController().signal;
  assert.equal((await fixture.run()).summary.outcome, "cancelled");
  assert.equal(fixture.repairs.tasks.length, 2);
  assert.equal(
    (await fixture.snapshot()).publication!.conflictRepair!.consumed,
    2,
  );
  assert.equal(
    (await fixture.snapshot()).publication!.conflictRepair!.generation,
    0,
  );
  assert.equal(fixture.publicationState.pushes, 1);
});

await test("operator authorization refreshes merge state and grants only a fresh conflict generation", async (t) => {
  const fixture = await conflictRepairRun(t);
  const repair = fixture.repairs.onTask;
  fixture.repairs.onTask = async (file, evidence) => {
    if (fixture.repairs.tasks.length > 2) {
      fixture.conflictState.mergeable = "mergeable";
      return repair(file, evidence);
    }
    await publish(file, {
      outcome: "no_change",
      summary: "No repair",
      commits: [],
      findings_file: null,
    });
  };
  let pauses = 0;
  fixture.dependencies.operator.pause = async (message) => {
    assert.match(message, /Conflict repair failed after two attempts/u);
    pauses++;
    fixture.conflictState.mergeable = "conflicting";
    return "";
  };
  assert.equal((await fixture.run()).summary.outcome, "succeeded");
  const saved = await fixture.snapshot();
  assert.equal(pauses, 1);
  assert.equal(saved.publication!.conflictRepair!.consumed, 1);
  assert.equal(saved.publication!.conflictRepair!.generation, 1);
  assert.equal(saved.publication!.ciRepair, undefined);
  assert.equal(fixture.repairs.probes.length, 3);
  assert.equal(fixture.conflictState.requests.length, 2);
});

await test("CI failure after conflict repair consumes the separate CI budget and integrates the latest head", async (t) => {
  const fixture = await conflictRepairRun(t);
  const ciCommit = {
    sha: "d".repeat(40),
    message: "fix: build after conflict",
  };
  fixture.publicationState.onChecks = async () =>
    fixture.publicationState.pushes === 2 ? [failedCheck] : [];
  fixture.scripts.ci.onTask = async (file, evidence) => {
    assert.equal(evidence.base, repairCommit.sha);
    evidence.commits = [ciCommit];
    evidence.changed = true;
    await publish(file, {
      outcome: "committed",
      summary: "Fixed build",
      commits: [ciCommit],
      findings_file: null,
    });
  };
  assert.equal((await fixture.run()).summary.outcome, "succeeded");
  const saved = await fixture.snapshot();
  assert.equal(saved.publication!.conflictRepair!.consumed, 1);
  assert.equal(saved.publication!.ciRepair!.consumed, 1);
  assert.equal(saved.publication!.merge!.headSha, ciCommit.sha);
  assert.equal(fixture.publicationState.creations, 1);
  assert.equal(fixture.publicationState.pushes, 3);
  assert.deepEqual(
    fixture.publicationState.discoveries,
    [40_000, 80_000, 120_000],
  );
  assert.equal((await fixture.run()).summary.outcome, "succeeded");
  assert.equal(fixture.repairs.tasks.length, 1);
  assert.equal(fixture.scripts.ci.tasks.length, 1);
});

await test("operator resolution after budget exhaustion refreshes checks before another merge request", async (t) => {
  const fixture = await conflictRepairRun(t);
  fixture.repairs.onTask = async (file) =>
    publish(file, {
      outcome: "no_change",
      summary: "No repair",
      commits: [],
      findings_file: null,
    });
  fixture.dependencies.operator.pause = async (message) => {
    assert.match(message, /Conflict repair failed after two attempts/u);
    fixture.conflictState.mergeable = "mergeable";
    fixture.conflictState.onMerge = async () => {
      assert.equal(fixture.publicationState.discoveries.length, 2);
      fixture.conflictState.merged = true;
      return { outcome: "accepted" };
    };
    return "";
  };
  assert.equal((await fixture.run()).summary.outcome, "succeeded");
  assert.equal(fixture.repairs.tasks.length, 2);
  assert.equal(
    (await fixture.snapshot()).publication!.conflictRepair!.generation,
    0,
  );
  assert.deepEqual(
    fixture.state.sleeps,
    [10_000, 30_000, 10_000, 10_000, 30_000],
  );
});

await test("a queue that reports an explicit conflict hands off to repair instead of waiting for timeout", async (t) => {
  const fixture = await conflictRepairRun(t);
  const merge = fixture.conflictState.onMerge;
  fixture.conflictState.onMerge = async () => {
    if (fixture.conflictState.requests.length === 1) {
      fixture.conflictState.mergeRequested = true;
      return { outcome: "accepted" };
    }
    return merge();
  };
  fixture.state.onSleep = async () => {
    if (fixture.conflictState.mergeRequested) {
      fixture.conflictState.mergeRequested = false;
      fixture.conflictState.mergeable = "conflicting";
    }
  };
  const repair = fixture.repairs.onTask;
  fixture.repairs.onTask = async (file, evidence) => {
    await repair(file, evidence);
    fixture.conflictState.mergeable = "mergeable";
  };
  assert.equal((await fixture.run()).summary.outcome, "succeeded");
  assert.equal(fixture.repairs.tasks.length, 1);
  assert.equal(fixture.dependencies.pauses.length, 0);
});

for (const present of [false, true]) {
  await test(`interrupted conflict repair recovers ${present ? "existing output without a tab" : "the exact conversation with continue"}`, async (t) => {
    const fixture = await conflictRepairRun(t);
    const repair = fixture.repairs.onTask;
    fixture.repairs.onTask = async (file, evidence) => {
      if (present) await repair(file, evidence);
      fixture.controller.abort();
    };
    assert.equal((await fixture.run()).summary.outcome, "cancelled");
    const pending = (await fixture.snapshot()).publication!.conflictRepair!
      .attempts[0]!;
    fixture.dependencies.signal = new AbortController().signal;
    fixture.repairs.onTask = repair;
    const opens = fixture.state.events.filter(
      (event) => event === "open",
    ).length;
    assert.equal((await fixture.run()).summary.outcome, "succeeded");
    const saved = (await fixture.snapshot()).publication!.conflictRepair!;
    assert.equal(saved.attempts[0]!.attempt_id, pending.attempt_id);
    assert.equal(saved.attempts[0]!.sessionid, "conflict-session-1");
    assert.equal(saved.consumed, 1);
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
  });
}

await test("lost conflict push response reconciles the original remote branch without another push", async (t) => {
  const fixture = await conflictRepairRun(t);
  const push = fixture.publicationState.onPush;
  fixture.publicationState.onPush = async (branch, head) => {
    await push(branch, head);
    if (head === repairCommit.sha) throw new Error("push response lost");
  };
  assert.equal((await fixture.run()).summary.outcome, "succeeded");
  assert.equal(fixture.publicationState.pushes, 2);
  assert.equal(
    (await fixture.snapshot()).publication!.conflictRepair!.consumed,
    1,
  );
});

await test("a repair without target ancestry consumes an attempt and never pushes its false claim", async (t) => {
  const fixture = await conflictRepairRun(t);
  const repair = fixture.repairs.onTask;
  fixture.repairs.onTask = async (file, evidence) => {
    fixture.conflictState.includesTarget = fixture.repairs.tasks.length > 1;
    await repair(file, evidence);
  };
  assert.equal((await fixture.run()).summary.outcome, "succeeded");
  const budget = (await fixture.snapshot()).publication!.conflictRepair!;
  assert.equal(budget.consumed, 2);
  assert.match(budget.attempts[0]!.verificationError!, /Target Branch SHA/u);
  assert.equal(budget.attempts[0]!.pushed, undefined);
  assert.equal(budget.attempts[1]!.pushed, true);
  assert.equal(fixture.publicationState.pushes, 2);
});

await test("conflict repair preserves the completed ordinary Review across matching recovery", async (t) => {
  const fixture = await conflictRepairRun(t, {
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
      await publish((await fixture.snapshot()).reviews![0]!.invocation!.path, {
        outcome: "passed",
        summary: "Standards and Spec pass",
        commits: [],
        findings_file: null,
      });
    }
  };
  assert.equal((await fixture.run()).summary.outcome, "succeeded");
  assert.equal((await fixture.run()).summary.outcome, "succeeded");
  assert.equal(reviews, 1);
  assert.equal(fixture.repairs.tasks.length, 1);
});

await test("cancellation after a conflict push resumes its pending evidence without pushing again", async (t) => {
  const fixture = await conflictRepairRun(t);
  const push = fixture.publicationState.onPush;
  fixture.publicationState.onPush = async (branch, head) => {
    await push(branch, head);
    if (head === repairCommit.sha) fixture.controller.abort();
  };
  assert.equal((await fixture.run()).summary.outcome, "cancelled");
  const pending = (await fixture.snapshot()).publication!.conflictRepair!
    .attempts[0]!;
  assert.equal(pending.pendingPush, repairCommit.sha);
  fixture.dependencies.signal = new AbortController().signal;
  assert.equal((await fixture.run()).summary.outcome, "succeeded");
  assert.equal(fixture.publicationState.pushes, 2);
  assert.equal(fixture.repairs.tasks.length, 1);
  assert.equal(
    (await fixture.snapshot()).publication!.conflictRepair!.attempts[0]!.pushed,
    true,
  );
});

await test("authorized conflict retry waits for explicit mergeability evidence before starting its next generation", async (t) => {
  const fixture = await conflictRepairRun(t);
  const repair = fixture.repairs.onTask;
  fixture.repairs.onTask = async (file, evidence) => {
    if (fixture.repairs.tasks.length > 2) {
      fixture.conflictState.mergeable = "mergeable";
      return repair(file, evidence);
    }
    await publish(file, {
      outcome: "no_change",
      summary: "No repair",
      commits: [],
      findings_file: null,
    });
  };
  let authorized = false;
  let observedUnknown = false;
  fixture.dependencies.operator.pause = async () => {
    authorized = true;
    return "";
  };
  fixture.state.onSleep = async (ms) => {
    if (
      authorized &&
      !observedUnknown &&
      ms === 10_000 &&
      fixture.repairs.tasks.length === 2
    ) {
      observedUnknown = true;
      assert.equal(
        (await fixture.snapshot()).publication!.conflictRepair!.generation,
        0,
      );
      fixture.conflictState.mergeable = "conflicting";
    }
  };
  assert.equal((await fixture.run()).summary.outcome, "succeeded");
  assert.equal(
    (await fixture.snapshot()).publication!.conflictRepair!.generation,
    1,
  );
  assert.equal(fixture.conflictState.requests.length, 2);
});

await test("recovery rejects corrupted conflict ownership, target ancestry context, and budget before dispatch", async (t) => {
  const fixture = await conflictRepairRun(t);
  fixture.state.onClose = async () => {
    if (fixture.state.closedTabs.length === 2) fixture.controller.abort();
  };
  assert.equal((await fixture.run()).summary.outcome, "cancelled");
  const directory = path.join(fixture.directory, "recovery");
  const file = path.join(directory, (await readdir(directory))[0]!);
  const original = await readFile(file, "utf8");
  const submissions = fixture.state.submissions.length;
  for (const field of [
    "worktree",
    "targetBase",
    "sessionid",
    "consumed",
    "conflict",
  ] as const) {
    const saved = JSON.parse(original) as Awaited<
      ReturnType<typeof fixture.snapshot>
    >;
    const budget = saved.publication!.conflictRepair!;
    const attempt = budget.attempts[0]!;
    if (field === "worktree")
      attempt.worktree = path.join(fixture.directory, "unrelated");
    else if (field === "consumed") budget.consumed = 0;
    else delete attempt[field];
    await writeFile(file, JSON.stringify(saved));
    fixture.dependencies.signal = new AbortController().signal;
    const result = await fixture.run();
    assert.equal(result.summary.outcome, "failed", field);
    assert.match(
      result.summary.reasons.join(" "),
      /unable to recover.*conflict repair/u,
      field,
    );
  }
  assert.equal(fixture.state.submissions.length, submissions);
  assert.equal(fixture.publicationState.pushes, 1);
});

await test("conflict evidence appearing during the final merge recheck repairs before issuing a merge request", async (t) => {
  const fixture = await conflictRepairRun(t);
  const observe = fixture.dependencies.codeHost.getPullRequest.bind(
    fixture.dependencies.codeHost,
  );
  let observations = 0;
  fixture.dependencies.codeHost.getPullRequest = async () => {
    const state = await observe("owner/repo", 81);
    if (++observations >= 2 && fixture.publicationState.pushes === 1)
      state.mergeable = "conflicting";
    return state;
  };
  assert.equal((await fixture.run()).summary.outcome, "succeeded");
  assert.equal(fixture.conflictState.requests.length, 1);
  assert.equal(fixture.conflictState.requests[0]!.headSha, repairCommit.sha);
});

await test("transient target ancestry inspection retries without consuming another repair attempt", async (t) => {
  const fixture = await conflictRepairRun(t);
  const git: GitWorkspace = fixture.dependencies.gitWorkspace;
  const inspect = git.inspect.bind(git);
  let failed = false;
  git.inspect = async (input) => {
    if (
      !failed &&
      input?.worktree.includes("conflict-repair") &&
      input.base === "a".repeat(40)
    ) {
      failed = true;
      throw new Error("transient ancestry inspection I/O failure");
    }
    return inspect(input);
  };
  const result = await fixture.run();
  assert.equal(result.summary.outcome, "succeeded", JSON.stringify(result));
  assert.equal(failed, true);
  assert.equal(fixture.repairs.tasks.length, 1);
  assert.equal(fixture.workspaces.size, 1);
  const budget = (await fixture.snapshot()).publication!.conflictRepair!;
  assert.equal(budget.consumed, 1);
  assert.equal(budget.attempts.length, 1);
  assert.equal(budget.attempts[0]!.verificationError, undefined);
  assert.ok(fixture.state.sleeps.includes(1000));
});

for (const response of ["", "q"] as const) {
  await test(`exhausted ancestry observation retries ${response === "" ? "resume" : "cancel"} through Operator Pause without invalidating the repair`, async (t) => {
    const fixture = await conflictRepairRun(t);
    const git: GitWorkspace = fixture.dependencies.gitWorkspace;
    const inspect = git.inspect.bind(git);
    let failures = 0;
    let pauses = 0;
    git.inspect = async (input) => {
      if (
        input.worktree.includes("conflict-repair") &&
        input.base === "a".repeat(40) &&
        failures < 2
      ) {
        failures++;
        throw new Error("ancestry inspection I/O unavailable");
      }
      return inspect(input);
    };
    fixture.dependencies.operator.pause = async (message) => {
      assert.match(message, /ancestry inspection I\/O unavailable/u);
      assert.equal(
        (await fixture.snapshot()).publication!.conflictRepair!.consumed,
        0,
      );
      pauses++;
      return response;
    };
    const result = await fixture.run();
    assert.equal(
      result.summary.outcome,
      response === "" ? "succeeded" : "cancelled",
      JSON.stringify(result),
    );
    assert.equal(failures, 2);
    assert.equal(pauses, 1);
    assert.equal(fixture.repairs.tasks.length, 1);
    const budget = (await fixture.snapshot()).publication!.conflictRepair!;
    assert.equal(budget.consumed, response === "" ? 1 : 0);
    assert.equal(budget.attempts.length, 1);
    assert.equal(budget.attempts[0]!.verificationError, undefined);
    assert.equal(fixture.publicationState.pushes, response === "" ? 2 : 1);
  });
}
