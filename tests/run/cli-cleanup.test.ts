/* eslint-disable @typescript-eslint/require-await -- Scripted external boundaries. */
import assert from "node:assert/strict";
import {
  access,
  mkdir,
  readFile,
  readdir,
  rm,
  writeFile,
} from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { executeCli } from "../../src/cli.ts";
import { integrationRun } from "../support/integration-run.ts";
import { documentationRun } from "../support/documentation-run.ts";
import {
  implementationCommand,
  implementationProgress,
  publish,
} from "../support/implementation-run.ts";
import { validConfig } from "../support/cli-project.ts";
import { findings, fixCommit } from "../support/review-run.ts";
import { child, parentDeliveryRun } from "../support/parent-run.ts";

await test("parent recovery finishes its final child's cleanup before parent closure without a documentation trigger", async (t) => {
  const fixture = await parentDeliveryRun(t, [child(51)]);
  let removals = 0;
  fixture.dependencies.gitWorkspace.cleanupWorktree = async () => {
    removals++;
    fixture.controller.abort();
  };
  assert.equal((await fixture.run()).summary.outcome, "cancelled");
  const saved = await implementationProgress(fixture.directory, 51);
  assert.equal(fixture.children[0]!.stateReason, "completed");
  assert.equal(fixture.parent.state, "open");
  assert.deepEqual(saved.cleanup?.worktrees, [saved.worktree]);
  assert.deepEqual(saved.cleanup?.files, []);
  await access(saved.invocation!.path);

  let parentClosedWithFiles = false;
  const close = fixture.dependencies.tracker.closeTicket.bind(
    fixture.dependencies.tracker,
  );
  fixture.dependencies.tracker.closeTicket = async (repository, number) => {
    if (number === 48)
      parentClosedWithFiles =
        (await readdir(path.join(fixture.directory, "handoffs"))).length > 0;
    await close(repository, number);
  };
  fixture.dependencies.signal = new AbortController().signal;
  const result = await fixture.run();
  assert.equal(result.summary.outcome, "succeeded", JSON.stringify(result));
  assert.equal(parentClosedWithFiles, false);
  assert.equal(removals, 1);
  assert.deepEqual(fixture.dispatched, [51]);
  assert.deepEqual(fixture.closures, [51, 48]);
  await assert.rejects(access(saved.invocation!.path), { code: "ENOENT" });
  assert.deepEqual(await readdir(path.join(fixture.directory, "handoffs")), []);
});

await test("successful delivery removes only its owned Worktree and assigned final, temporary, and superseded files", async (t) => {
  const fixture = await integrationRun(t);
  const cleaned: string[] = [];
  const unrelated = path.join(fixture.directory, "handoffs", "51-other.json");
  const history = path.join(fixture.directory, "native-history.json");
  fixture.dependencies.gitWorkspace.cleanupWorktree = async (input) => {
    assert.equal(fixture.state.ticket.stateReason, "completed");
    cleaned.push(input.worktree);
  };
  const task = fixture.state.onTask;
  fixture.state.onTask = async (file) => {
    const progress = await fixture.snapshot();
    await access(progress.probe!.path);
    await writeFile(unrelated, "another Issue");
    await writeFile(history, "native conversation");
    await writeFile(`${progress.probe!.path}.tmp`, "unfinished sibling");
    await writeFile(file, "invalid");
  };
  fixture.state.onCorrection = async (file) => {
    const progress = await fixture.snapshot();
    await access(progress.superseded[0]!);
    await writeFile(`${progress.superseded[0]!}.tmp`, "unfinished correction");
    await task(file);
    await writeFile(`${file}.tmp`, "leftover temporary");
  };
  const result = await fixture.run();
  assert.equal(result.summary.outcome, "succeeded", JSON.stringify(result));
  const saved = await fixture.snapshot();
  assert.deepEqual(cleaned, [saved.worktree]);
  assert.deepEqual(await readdir(path.dirname(unrelated)), [
    path.basename(unrelated),
  ]);
  await access(history);
  for (const config of fixture.state.gitConfigs)
    await assert.rejects(access(config), { code: "ENOENT" });
  assert.equal(fixture.state.closedTabs.length, 1);
});

for (const document of [false, true]) {
  await test(`${document ? "documentation" : "Issue"} cleanup resumes only unfinished actions after a file deletion failure`, async (t) => {
    const fixture = document
      ? await documentationRun(t)
      : await integrationRun(t);
    fixture.state.onClose = async () => {
      const saved = await fixture.snapshot();
      await mkdir(`${saved.invocation!.path}.tmp`);
    };
    fixture.dependencies.operator.pause = async (message) => {
      assert.match(message, /directory/u);
      return "q";
    };
    const first = await fixture.run();
    assert.equal(first.summary.outcome, "cancelled", JSON.stringify(first));
    const saved = await fixture.snapshot();
    assert.deepEqual(saved.cleanup?.worktrees, [saved.worktree]);
    assert.ok(saved.cleanup?.files.includes(saved.invocation!.path));
    assert.equal(
      saved.cleanup?.files.includes(`${saved.invocation!.path}.tmp`),
      false,
    );
    const audit = await readFile(first.logPath!, "utf8");
    assert.match(audit, /"operation":"cleanup_handoff".*"result":"failed"/u);
    for (const file of saved.cleanup.files)
      await writeFile(file, "must not repeat a completed deletion");
    await rm(`${saved.invocation!.path}.tmp`, { recursive: true });
    await writeFile(`${saved.invocation!.path}.tmp`, "remaining file");
    fixture.dependencies.signal = new AbortController().signal;
    fixture.dependencies.gitWorkspace.cleanupWorktree = async () => {
      assert.fail("completed Worktree removal must not repeat");
    };
    fixture.dependencies.operator.pause = async (message) => {
      assert.match(message, /directory/u);
      return "";
    };
    assert.equal((await fixture.run()).summary.outcome, "succeeded");
    for (const file of saved.cleanup.files) await access(file);
    await assert.rejects(access(`${saved.invocation!.path}.tmp`), {
      code: "ENOENT",
    });
    assert.equal(fixture.state.taskCount, 1);
    assert.equal(fixture.integrationState.requests.length, 1);
    assert.equal(fixture.integrationState.closures, 1);
  });
}

await test("successful cleanup includes Review and fix assignments while findings keep their Review-loop cleanup timing", async (t) => {
  const config = {
    ...validConfig,
    workflow: { review: true, maxReviewRounds: 1 },
  };
  const fixture = await integrationRun(t, config);
  const probe = fixture.state.onProbe;
  fixture.state.onProbe = async (assignment) => {
    if (assignment.role === "review")
      await publish(String(assignment.path), {
        sessionid: "review-native",
      });
    else await probe(assignment);
  };
  const submit = fixture.dependencies.terminalPlugin.submitText.bind(
    fixture.dependencies.terminalPlugin,
  );
  fixture.dependencies.terminalPlugin.submitText = async (tab, text, chord) => {
    await submit(tab, text, chord);
    const saved = await fixture.snapshot();
    const round = saved.reviews?.at(-1);
    if (text.startsWith("Review assignment\n")) {
      await access(saved.invocation!.path);
      await findings(round!);
    } else if (text.startsWith("Fix assignment\n")) {
      await access(round!.findings);
      await access(round!.invocation!.path);
      fixture.state.evidence.commits.push(fixCommit);
      fixture.integrationState.pullRequest.headSha = fixCommit.sha;
      await publish(round!.fix!.invocation!.path, {
        outcome: "committed",
        summary: "Fixed findings",
        commits: [fixCommit],
        findings_file: null,
      });
    }
  };
  fixture.publicationState.onChecks = async () => {
    const saved = await fixture.snapshot();
    await assert.rejects(access(saved.reviews![0]!.findings), {
      code: "ENOENT",
    });
    for (const stage of [saved, saved.reviews![0]!, saved.reviews![0]!.fix!])
      await access(stage.invocation!.path);
    return [];
  };
  const result = await fixture.run();
  assert.equal(result.summary.outcome, "succeeded", JSON.stringify(result));
  assert.deepEqual(await readdir(path.join(fixture.directory, "handoffs")), []);
  assert.equal(fixture.state.cleanup[0]!.headSha, fixCommit.sha);
  assert.equal(fixture.state.closedTabs.length, 3);
  assert.equal(new Set(fixture.state.closedTabs).size, 3);
});

for (const outcome of [
  "no-auto-merge",
  "failed",
  "cancelled",
  "incomplete",
] as const) {
  await test(`${outcome} retains assigned files and Worktree without successful cleanup`, async (t) => {
    const fixture = await integrationRun(t);
    const task = fixture.state.onTask;
    fixture.state.onTask = async (file) => {
      await task(file);
      if (outcome === "cancelled") fixture.controller.abort();
      if (outcome === "failed") throw new Error("prompt transport failed");
    };
    if (outcome === "incomplete")
      fixture.integrationState.onMerge = async () => {
        fixture.integrationState.pullRequest.merged = true;
        fixture.state.ticket.state = "closed";
        fixture.state.ticket.stateReason = "not_planned";
        return { outcome: "accepted" };
      };
    const result =
      outcome === "no-auto-merge"
        ? await executeCli(implementationCommand, fixture.dependencies)
        : await fixture.run();
    assert.equal(
      result.summary.outcome,
      outcome === "no-auto-merge" ? "incomplete" : outcome,
    );
    const saved = await fixture.snapshot();
    assert.equal(saved.cleanup, undefined);
    assert.deepEqual(fixture.state.cleanup, []);
    for (const file of [
      saved.worktree,
      saved.probe!.path,
      saved.invocation!.path,
    ])
      await access(file);
    for (const file of fixture.state.gitConfigs)
      await assert.rejects(access(file), { code: "ENOENT" });
  });
}

await test("rejected stage close retains accepted output and cannot earn successful cleanup", async (t) => {
  const fixture = await integrationRun(t);
  fixture.state.onClose = async () => {
    throw new Error("targeted close rejected");
  };
  fixture.dependencies.operator.pause = async (message) => {
    assert.match(message, /targeted close rejected/u);
    return "q";
  };
  assert.equal((await fixture.run()).summary.outcome, "cancelled");
  const saved = await fixture.snapshot();
  assert.equal(saved.phase, "implementation_completed");
  assert.equal(saved.cleanup, undefined);
  assert.deepEqual(fixture.state.cleanup, []);
  assert.equal(new Set(fixture.state.closedTabs).size, 1);
  await access(saved.probe!.path);
  await access(saved.invocation!.path);
});

await test("a recovered cleanup rejects another Issue's assigned path before deleting any resources", async (t) => {
  const fixture = await integrationRun(t);
  fixture.integrationState.onClose = async () => {
    fixture.state.ticket.state = "closed";
    fixture.state.ticket.stateReason = "completed";
    fixture.controller.abort();
  };
  assert.equal((await fixture.run()).summary.outcome, "cancelled");
  const saved = await fixture.snapshot();
  const unrelated = path.join(
    fixture.directory,
    "handoffs",
    "51-owned-by-another-Issue.json",
  );
  await writeFile(unrelated, "retain");
  saved.superseded.push(unrelated);
  const recovery = path.join(fixture.directory, "recovery");
  const file = (await readdir(recovery)).find((file) =>
    file.endsWith("-50.json"),
  )!;
  await writeFile(path.join(recovery, file), JSON.stringify(saved));
  fixture.dependencies.signal = new AbortController().signal;
  const result = await fixture.run();
  assert.equal(result.summary.outcome, "failed");
  assert.match(result.summary.reasons.join(" "), /handoff ownership mismatch/u);
  assert.deepEqual(fixture.state.cleanup, []);
  for (const file of [
    unrelated,
    saved.worktree,
    saved.probe!.path,
    saved.invocation!.path,
  ])
    await access(file);
});

for (const document of [false, true]) {
  await test(`${document ? "documentation" : "Issue"} cancellation after Worktree removal checkpoints that action and recovery only removes unfinished files`, async (t) => {
    const fixture = document
      ? await documentationRun(t)
      : await integrationRun(t);
    let removals = 0;
    fixture.dependencies.gitWorkspace.cleanupWorktree = async () => {
      removals++;
      fixture.controller.abort();
    };
    assert.equal((await fixture.run()).summary.outcome, "cancelled");
    const saved = await fixture.snapshot();
    assert.deepEqual(saved.cleanup?.worktrees, [saved.worktree]);
    await access(saved.invocation!.path);
    fixture.dependencies.signal = new AbortController().signal;
    fixture.dependencies.gitWorkspace.cleanupWorktree = async () => {
      assert.fail("completed Worktree cleanup must not repeat");
    };
    assert.equal((await fixture.run()).summary.outcome, "succeeded");
    assert.equal(removals, 1);
    assert.equal(fixture.state.taskCount, 1);
    assert.equal(fixture.integrationState.requests.length, 1);
    assert.equal(fixture.integrationState.closures, 1);
    await assert.rejects(access(saved.invocation!.path), { code: "ENOENT" });
  });
}
