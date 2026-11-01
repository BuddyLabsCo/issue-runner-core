/* eslint-disable @typescript-eslint/require-await -- Scripted external boundaries. */
import { promptAssignment } from "../support/prompt-assignment.ts";
import assert from "node:assert/strict";
import { access, readFile, readdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { executeCli } from "../../src/cli.ts";
import { ciRepairRun, repairCommit } from "../support/ci-repair-run.ts";
import { conflictRepairRun } from "../support/conflict-repair-run.ts";
import { validConfig } from "../support/cli-project.ts";
import {
  deferred,
  implementationProgress,
  publish,
} from "../support/implementation-run.ts";
import { child, parentRun } from "../support/parent-run.ts";

for (const kind of ["ci", "conflict"] as const) {
  await test(`missing active ${kind} repair Worktree fails recovery before native dispatch`, async (t) => {
    const fixture = await (kind === "ci" ? ciRepairRun : conflictRepairRun)(t);
    fixture.repairs.onTask = async () => {
      fixture.controller.abort();
    };
    assert.equal((await fixture.run()).summary.outcome, "cancelled");
    const saved = await fixture.snapshot();
    const attempt =
      saved.publication![
        kind === "ci" ? "ciRepair" : "conflictRepair"
      ]!.attempts.at(-1)!;
    assert.equal(attempt.worktreeCreated, true);
    assert.ok(attempt.invocation);
    assert.equal(attempt.result, undefined);
    await rm(attempt.worktree, { recursive: true });
    await access(saved.worktree);
    const submissions = fixture.state.submissions.length;
    const pushes = fixture.publicationState.pushes;
    const workspaces = fixture.workspaces.size;
    let opens = 0;
    fixture.dependencies.terminalPlugin.createTab = async () => {
      opens++;
      throw new Error("Missing repair context must not open a Runner Tab");
    };
    fixture.dependencies.signal = new AbortController().signal;
    fixture.dependencies.operator.pause = async (message) => {
      assert.equal(
        message,
        "Enter to restart the entire Issue #50, or q to exit Runner.",
      );
      return "q";
    };
    const result = await fixture.run();
    assert.equal(result.summary.outcome, "cancelled");
    assert.ok(fixture.dependencies.messages.includes("unable to recover"));
    assert.equal(opens, 0);
    assert.equal(fixture.state.submissions.length, submissions);
    assert.equal(fixture.publicationState.pushes, pushes);
    assert.equal(fixture.workspaces.size, workspaces);
    assert.deepEqual(await fixture.snapshot(), saved);
    await access(saved.worktree);
    await access(attempt.probe!.path);
    await assert.rejects(access(attempt.worktree));
  });
}

await test("restarting an unrecoverable repair replaces the whole Issue and retains its old repair resources", async (t) => {
  const fixture = await ciRepairRun(t);
  fixture.repairs.onTask = async () => fixture.controller.abort();
  assert.equal((await fixture.run()).summary.outcome, "cancelled");
  const before = await fixture.snapshot();
  const repair = before.publication!.ciRepair!.attempts[0]!;
  const recovery = path.join(fixture.directory, "recovery");
  const file = path.join(recovery, `${before.input_hash}-50.json`);
  await publish(file, {
    ...before,
    publication: {
      ...before.publication,
      ciRepair: {
        ...before.publication!.ciRepair,
        attempts: [{ ...repair, sessionid: undefined }],
      },
    },
  });
  const retained = await readFile(file, "utf8");
  const controller = new AbortController();
  fixture.dependencies.signal = controller.signal;
  fixture.dependencies.operator.pause = async (message) => {
    assert.equal(
      message,
      "Enter to restart the entire Issue #50, or q to exit Runner.",
    );
    return "";
  };
  const create = fixture.dependencies.gitWorkspace.createWorktree.bind(
    fixture.dependencies.gitWorkspace,
  );
  fixture.dependencies.gitWorkspace.createWorktree = async (input) => {
    await create(input);
    fixture.state.evidence.commits = [];
  };
  fixture.state.onTask = async () => controller.abort();
  const restarted = await fixture.run();
  assert.equal(
    restarted.summary.outcome,
    "cancelled",
    JSON.stringify(restarted),
  );
  const after = await fixture.snapshot();
  assert.notEqual(after.execution_id, before.execution_id);
  assert.notEqual(after.worktree, before.worktree);
  assert.notEqual(after.branch, before.branch);
  assert.notDeepEqual(after.probe, before.probe);
  assert.notDeepEqual(after.invocation, before.invocation);
  assert.equal(after.publication, undefined);
  assert.equal(after.corrections, 0);
  assert.equal(fixture.state.taskCount, 2);
  assert.equal(fixture.repairs.tasks.length, 1);
  assert.equal(fixture.publicationState.creations, 1);
  assert.equal(fixture.publicationState.pushes, 1);
  for (const stage of [before, repair]) {
    await access(stage.worktree);
    await access(stage.probe!.path);
  }
  const archive = (await readdir(recovery)).find((name) =>
    name.endsWith(".retained"),
  )!;
  assert.equal(await readFile(path.join(recovery, archive), "utf8"), retained);
});

for (const kind of ["ci", "conflict"] as const) {
  await test(`completed ${kind} repair rechecks Git evidence before its recovered pending push`, async (t) => {
    const fixture = await (kind === "ci" ? ciRepairRun : conflictRepairRun)(t);
    fixture.state.onClose = async () => {
      if (fixture.state.closedTabs.length === 2) fixture.controller.abort();
    };
    assert.equal((await fixture.run()).summary.outcome, "cancelled");
    const key = kind === "ci" ? "ciRepair" : "conflictRepair";
    const before = await fixture.snapshot();
    const repair = before.publication![key]!.attempts[0]!;
    assert.equal(repair.counted, true);
    fixture.workspaces.get(repair.worktree)!.clean = false;
    fixture.dependencies.signal = new AbortController().signal;
    fixture.dependencies.operator.pause = async (message) => {
      assert.match(message, /clean/u);
      return "q";
    };
    const submissions = fixture.state.submissions.length;
    assert.equal((await fixture.run()).summary.outcome, "cancelled");
    const after = await fixture.snapshot();
    assert.equal(after.publication![key]!.consumed, 1);
    assert.equal(
      after.publication![key]!.attempts[0]!.pendingPush,
      repairCommit.sha,
    );
    assert.equal(after.publication![key]!.attempts[0]!.pushed, undefined);
    assert.equal(fixture.publicationState.pushes, 1);
    assert.equal(fixture.state.submissions.length, submissions);
  });
}

await test(
  "skipping exhausted CI repair retains the Issue resources and lets sibling work continue",
  { timeout: 10_000 },
  async (t) => {
    const children = [child(51), child(52)];
    const fixture = await parentRun(t, children, {
      ...validConfig,
      maxBatchSize: 2,
    });
    const releaseSibling = deferred<void>();
    t.after(() => releaseSibling.resolve());
    const tabs = new Map<object, number>();
    const open = fixture.dependencies.terminalPlugin.createTab.bind(
      fixture.dependencies.terminalPlugin,
    );
    fixture.dependencies.terminalPlugin.createTab = async (options) => {
      const tab = await open(options);
      tabs.set(tab, Number(/ticket-(\d+)/u.exec(options.cwd)![1]));
      return tab;
    };
    const submit = fixture.dependencies.terminalPlugin.submitText.bind(
      fixture.dependencies.terminalPlugin,
    );
    fixture.dependencies.terminalPlugin.submitText = async (tab, text) => {
      if (text.startsWith("Session Probe\n")) {
        const assignment = promptAssignment(text) as {
          path: string;
          role: string;
        };
        if (assignment.role === "ciRepair") {
          await publish(assignment.path, {
            sessionid: "ci-repair-session",
          });
          return;
        }
      }
      if (text.startsWith("CI repair assignment\n")) {
        const assignment = promptAssignment(text) as { path: string };
        await publish(assignment.path, {
          outcome: "no_change",
          summary: "No repair",
          commits: [],
          findings_file: null,
        });
        return;
      }
      if (
        text.startsWith("Implementation assignment\n") &&
        tabs.get(tab) === 52
      )
        await releaseSibling.promise;
      await submit(tab, text);
    };
    let pauses = 0;
    fixture.dependencies.operator.pause = async (message) => {
      assert.match(message, /CI repair failed after two attempts/u);
      if (++pauses === 1) {
        assert.equal(fixture.dispatched.includes(52), false);
        releaseSibling.resolve();
        return "s";
      }
      return "q";
    };
    const issueByPr = new Map<number, number>();
    const host = fixture.dependencies.codeHost;
    const result = await executeCli(
      ["run", "--project", "demo", "--env", "fake", "--parent", "48"],
      {
        ...fixture.dependencies,
        codeHost: {
          ...host,
          async createPullRequest(input) {
            const pr = await host.createPullRequest(input);
            issueByPr.set(
              pr.number,
              Number(/ticket-(\d+)$/u.exec(input.branch)![1]),
            );
            return pr;
          },
          async getRequiredChecks(_repository, pr) {
            return issueByPr.get(pr) === 51
              ? [
                  {
                    name: "build",
                    state: "FAILURE",
                    link: "https://checks/build/51",
                    bucket: "fail",
                  },
                ]
              : [];
          },
        },
      },
    );
    assert.equal(result.summary.outcome, "incomplete", JSON.stringify(result));
    assert.equal(pauses, 1);
    assert.match(result.summary.reasons.join(" "), /skipped Issue #51/u);
    assert.match(result.summary.reasons.join(" "), /Issue #52: CI-ready/u);
    assert.deepEqual(fixture.dispatched.sort(), [51, 52]);
    const saved = await implementationProgress(fixture.directory, 51);
    assert.equal(saved.publication!.ciRepair!.consumed, 2);
    assert.equal(saved.publication!.ciRepair!.attempts.length, 2);
    assert.equal(saved.publication!.ciRepair!.generation, 0);
    for (const workspace of [saved, ...saved.publication!.ciRepair!.attempts]) {
      await access(workspace.worktree);
      await access(workspace.probe!.path);
      await access(workspace.invocation!.path);
    }
    assert.equal(children[0]!.state, "open");
    assert.ok(
      children[0]!.labels!.includes(validConfig.tracker.reservationLabel),
    );
    assert.ok(
      children[0]!.assignees!.includes(validConfig.tracker.runnerAccount),
    );
  },
);

await test("blocked repair output is corrected in the same native stage rather than revived as a blocked result", async (t) => {
  const fixture = await ciRepairRun(t);
  const repair = fixture.repairs.onTask;
  let calls = 0;
  fixture.repairs.onTask = async (file, evidence) => {
    if (++calls === 1)
      await publish(file, {
        outcome: "blocked",
        summary: "Need input",
        commits: [],
        findings_file: null,
      });
    else await repair(file, evidence);
  };
  assert.match((await fixture.run()).summary.reasons.join(" "), /CI-ready/u);
  const budget = (await fixture.snapshot()).publication!.ciRepair!;
  assert.equal(budget.consumed, 1);
  assert.equal(budget.attempts.length, 1);
  assert.equal(budget.attempts[0]!.corrections, 1);
  assert.equal(fixture.repairs.probes.length, 1);
  assert.equal(fixture.state.closedTabs.length, 2);
});

await test("repair Worktree creation interrupted after its side effect reconciles the recorded empty workspace", async (t) => {
  const fixture = await ciRepairRun(t);
  const create = fixture.dependencies.gitWorkspace.createWorktree.bind(
    fixture.dependencies.gitWorkspace,
  );
  let repairCreates = 0;
  fixture.dependencies.gitWorkspace.createWorktree = async (input) => {
    await create(input);
    if (input.branch.includes("ci-repair") && ++repairCreates === 1)
      fixture.controller.abort();
  };
  assert.equal((await fixture.run()).summary.outcome, "cancelled");
  const pending = (await fixture.snapshot()).publication!.ciRepair!
    .attempts[0]!;
  assert.equal(pending.worktreeCreated, undefined);
  fixture.dependencies.signal = new AbortController().signal;
  assert.match((await fixture.run()).summary.reasons.join(" "), /CI-ready/u);
  assert.equal(repairCreates, 1);
  assert.equal(
    (await fixture.snapshot()).publication!.ciRepair!.attempts[0]!.attempt_id,
    pending.attempt_id,
  );
});

await test("unexpected remote advancement after repair completion never overwrites remote work", async (t) => {
  const fixture = await ciRepairRun(t);
  fixture.state.onClose = async () => {
    if (fixture.state.closedTabs.length === 2) {
      const saved = await fixture.snapshot();
      fixture.publicationState.branches.set(saved.branch, "d".repeat(40));
    }
  };
  fixture.dependencies.operator.pause = async (message) => {
    assert.match(message, /advanced/u);
    return "q";
  };
  assert.equal((await fixture.run()).summary.outcome, "cancelled");
  assert.equal(fixture.publicationState.pushes, 1);
  const budget = (await fixture.snapshot()).publication!.ciRepair!;
  assert.equal(budget.consumed, 1);
  assert.equal(budget.attempts[0]!.pendingPush, repairCommit.sha);
});

await test("restart preserves an exhausted CI generation until the operator authorizes retry", async (t) => {
  const fixture = await ciRepairRun(t);
  fixture.repairs.onTask = async (file) => {
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
    return "q";
  };
  assert.equal((await fixture.run()).summary.outcome, "cancelled");
  fixture.dependencies.signal = new AbortController().signal;
  assert.equal((await fixture.run()).summary.outcome, "cancelled");
  assert.equal(pauses, 2);
  assert.equal(fixture.repairs.tasks.length, 2);
  const budget = (await fixture.snapshot()).publication!.ciRepair!;
  assert.equal(budget.consumed, 2);
  assert.equal(budget.attempts.length, 2);
  assert.equal(fixture.publicationState.pushes, 1);
  assert.equal((await fixture.snapshot()).publication!.ciRepair!.generation, 0);
});

await test("repair pushes retain the discovery deadline across cancellation and recovery", async (t) => {
  const fixture = await ciRepairRun(t);
  fixture.state.onSleep = async (ms) => {
    if (ms === 30_000 && fixture.publicationState.pushes === 2)
      fixture.controller.abort();
  };
  assert.equal((await fixture.run()).summary.outcome, "cancelled");
  const before = await fixture.snapshot();
  assert.equal(before.publication!.ciRepair!.attempts[0]!.pushed, true);
  assert.equal(fixture.publicationState.discoveries.length, 1);
  fixture.dependencies.signal = new AbortController().signal;
  fixture.state.onSleep = async () => {
    /* Cancellation is disabled for recovery. */
  };
  assert.match((await fixture.run()).summary.reasons.join(" "), /CI-ready/u);
  assert.equal(fixture.publicationState.pushes, 2);
  assert.equal(
    (await fixture.snapshot()).publication!.discoveryNotBefore,
    before.publication!.discoveryNotBefore,
  );
});

await test("recovery rejects corrupted repair ownership, pending evidence, and budget before dispatch", async (t) => {
  const fixture = await ciRepairRun(t);
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
    "pendingPush",
    "consumed",
    "sessionid",
    "invocation",
  ] as const) {
    const saved = JSON.parse(original) as Awaited<
      ReturnType<typeof fixture.snapshot>
    >;
    const budget = saved.publication!.ciRepair!;
    const attempt = budget.attempts[0]!;
    if (field === "worktree")
      attempt.worktree = path.join(fixture.directory, "unrelated");
    else if (field === "pendingPush") attempt.pendingPush = "d".repeat(40);
    else if (field === "consumed") budget.consumed = 0;
    else if (field === "sessionid") delete attempt.sessionid;
    else
      attempt.invocation!.path = path.join(fixture.directory, "unowned.json");
    await writeFile(file, JSON.stringify(saved));
    fixture.dependencies.signal = new AbortController().signal;
    fixture.dependencies.operator.pause = async (message) => {
      assert.equal(
        message,
        "Enter to restart the entire Issue #50, or q to exit Runner.",
      );
      return "q";
    };
    const result = await fixture.run();
    assert.equal(result.summary.outcome, "cancelled", field);
    assert.ok(
      fixture.dependencies.messages.includes("unable to recover"),
      field,
    );
  }
  assert.equal(fixture.state.submissions.length, submissions);
  assert.equal(fixture.publicationState.pushes, 1);
});
