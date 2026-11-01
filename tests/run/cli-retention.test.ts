import assert from "node:assert/strict";
import {
  access,
  appendFile,
  readFile,
  readdir,
  rm,
  writeFile,
} from "node:fs/promises";
import { spawn } from "node:child_process";
import { once } from "node:events";
import path from "node:path";
import test from "node:test";
import {
  implementationCommand,
  implementationRun,
  publish,
} from "../support/implementation-run.ts";
import { executeCli } from "../../src/cli.ts";
import type { ImplementationProgress } from "../../src/recovery.ts";
import { ciRepairRun } from "../support/ci-repair-run.ts";
import { findings, reviewRun } from "../support/review-run.ts";
import { documentationRun } from "../support/documentation-run.ts";

await test("cancellation reports and retains original working changes, partial files and superseded handoffs", async (t) => {
  const fixture = await implementationRun(t);
  fixture.state.onTask = async (file) => {
    const saved = await fixture.snapshot();
    await writeFile(
      path.join(saved.worktree, "unfinished.txt"),
      "original work\n",
    );
    await publish(file, {});
  };
  fixture.state.onCorrection = async (file) => {
    await writeFile(`${file}.tmp`, "partial handoff");
    fixture.controller.abort();
  };
  const result = await fixture.run();
  assert.equal(result.summary.outcome, "cancelled");
  assert.equal(result.exitCode, 1);
  const saved = await fixture.snapshot();
  assert.equal(saved.corrections, 1);
  assert.equal(saved.pr_title, "feat: [issue-50] implement the Issue");
  assert.equal(saved.pr_body, "Implement the Issue.\n\nCloses #50");
  assert.equal(saved.roles.implement?.sessionid, "native/$&/$`/$'/session");
  assert.equal(
    await readFile(path.join(saved.worktree, "unfinished.txt"), "utf8"),
    "original work\n",
  );
  const report = fixture.dependencies.messages
    .filter((message) => message.startsWith("Retained "))
    .join("\n");
  for (const file of [
    saved.worktree,
    saved.probe!.path,
    saved.superseded[0]!,
    `${saved.invocation!.path}.tmp`,
  ]) {
    await access(file);
    assert.ok(report.includes(file), `missing retained path: ${file}`);
  }
  assert.ok(report.includes(saved.execution_id));
  assert.ok(report.includes(saved.branch));
  assert.ok(report.includes(path.join(fixture.directory, "recovery")));
  for (const file of fixture.state.gitConfigs)
    await assert.rejects(access(file));
});

for (const changed of ["arguments", "configuration"] as const) {
  await test(`changed ${changed} retains old artifacts without adopting the existing Reservation`, async (t) => {
    const fixture = await implementationRun(t);
    fixture.state.onTask = async (file) => {
      await writeFile(`${file}.tmp`, "old unfinished work");
      fixture.controller.abort();
    };
    assert.equal((await fixture.run()).summary.outcome, "cancelled");
    const previous = await fixture.snapshot();
    const unrelated = path.join(
      fixture.directory,
      "handoffs",
      "unrelated.json",
    );
    await writeFile(unrelated, "unrelated handoff");
    const files = await readdir(path.join(fixture.directory, "recovery"));
    assert.equal(files.length, 1);
    const snapshot = path.join(fixture.directory, "recovery", files[0]!);
    const bytes = await readFile(snapshot, "utf8");
    if (changed === "configuration")
      await appendFile(
        path.join(fixture.directory, "config.yaml"),
        "\n# changed Run\n",
      );
    fixture.dependencies.signal = new AbortController().signal;
    fixture.dependencies.messages.length = 0;
    const result = await executeCli(
      changed === "arguments"
        ? implementationCommand.slice(0, -1)
        : implementationCommand,
      fixture.dependencies,
    );
    assert.equal(result.summary.outcome, "incomplete");
    assert.match(result.summary.reasons.join(" "), /existing Reservation/u);
    assert.equal(fixture.state.taskCount, 1);
    assert.equal(await readFile(snapshot, "utf8"), bytes);
    await access(previous.worktree);
    await access(previous.probe!.path);
    assert.equal(
      await readFile(`${previous.invocation!.path}.tmp`, "utf8"),
      "old unfinished work",
    );
    assert.equal(await readFile(unrelated, "utf8"), "unrelated handoff");
    assert.equal(
      fixture.dependencies.messages.some((message) =>
        message.startsWith("Retained "),
      ),
      false,
    );
  });
}

await test(
  "abrupt process loss leaves its original working changes and durable execution evidence",
  { timeout: 10_000 },
  async (t) => {
    const support = new URL("../support/implementation-run.ts", import.meta.url)
      .href;
    const script = `
    import { writeFile } from "node:fs/promises";
    import path from "node:path";
    import { implementationRun } from ${JSON.stringify(support)};
    const fixture = await implementationRun({ after() {} });
    fixture.state.onTask = async (file) => {
      const progress = await fixture.snapshot();
      await writeFile(path.join(progress.worktree, "unfinished.txt"), "work before interruption");
      await writeFile(file + ".tmp", "partial before interruption");
      process.send({ directory: fixture.directory, progress });
      await new Promise(() => setInterval(() => {}, 1000));
    };
    await fixture.run();
  `;
    const child = spawn(
      process.execPath,
      ["--input-type=module", "--eval", script],
      {
        stdio: ["ignore", "ignore", "pipe", "ipc"],
      },
    );
    t.after(() => {
      child.kill("SIGKILL");
    });
    let diagnostics = "";
    assert.ok(child.stderr);
    child.stderr.setEncoding("utf8").on("data", (chunk: string) => {
      diagnostics += chunk;
    });
    const exit = once(child, "exit");
    const message: unknown = (
      await Promise.race([
        once(child, "message"),
        exit.then(() => {
          throw new Error(`child exited before dispatch: ${diagnostics}`);
        }),
      ])
    )[0];
    const { directory, progress } = message as {
      directory: string;
      progress: ImplementationProgress;
    };
    t.after(() =>
      rm(path.dirname(directory), { recursive: true, force: true }),
    );
    child.kill("SIGKILL");
    await exit;
    const snapshots = await readdir(path.join(directory, "recovery"));
    assert.equal(snapshots.length, 1);
    assert.deepEqual(
      JSON.parse(
        await readFile(path.join(directory, "recovery", snapshots[0]!), "utf8"),
      ),
      progress,
    );
    assert.equal(progress.phase, "implementing");
    assert.equal(progress.pr_title, "feat: [issue-50] implement the Issue");
    await access(progress.probe!.path);
    assert.equal(
      await readFile(`${progress.invocation!.path}.tmp`, "utf8"),
      "partial before interruption",
    );
    assert.equal(
      await readFile(path.join(progress.worktree, "unfinished.txt"), "utf8"),
      "work before interruption",
    );
  },
);

await test("a failed execution reports its resources without deleting diagnostic files", async (t) => {
  const fixture = await implementationRun(t);
  fixture.state.onTask = async (file) => {
    await writeFile(`${file}.tmp`, "unfinished result");
    throw new Error("terminal transport failed");
  };
  const result = await fixture.run();
  assert.equal(result.summary.outcome, "failed");
  assert.match(result.summary.reasons.join(" "), /terminal transport failed/u);
  const saved = await fixture.snapshot();
  const report = fixture.dependencies.messages
    .filter((message) => message.startsWith("Retained "))
    .join("\n");
  for (const file of [
    saved.worktree,
    saved.probe!.path,
    `${saved.invocation!.path}.tmp`,
  ]) {
    await access(file);
    assert.ok(report.includes(file));
  }
  assert.equal(
    await readFile(`${saved.invocation!.path}.tmp`, "utf8"),
    "unfinished result",
  );
  for (const file of fixture.state.gitConfigs)
    await assert.rejects(access(file));
});

await test("no-auto-merge retains and reports failed and replacement repair executions on the original PR", async (t) => {
  const fixture = await ciRepairRun(t);
  const repair = fixture.repairs.onTask;
  fixture.repairs.onTask = async (file, evidence) => {
    await repair(file, evidence);
    if (fixture.repairs.tasks.length === 1) evidence.clean = false;
  };
  const result = await fixture.run();
  assert.equal(result.summary.outcome, "incomplete");
  assert.equal(result.exitCode, 1);
  const saved = await fixture.snapshot();
  const attempts = saved.publication!.ciRepair!.attempts;
  assert.equal(attempts.length, 2);
  assert.equal(saved.publication!.ciRepair!.consumed, 2);
  assert.equal(attempts[0]!.corrections, 0);
  assert.equal(attempts[1]!.pushed, true);
  assert.equal(fixture.publicationState.pushes, 2);
  assert.equal(fixture.repairs.probes.length, 2);
  assert.match(attempts[0]!.verificationError!, /clean/u);
  assert.equal(saved.publication!.phase, "checks_ready");
  assert.equal(fixture.publicationState.creations, 1);
  assert.equal(saved.publication!.title, saved.pr_title);
  assert.equal(saved.publication!.body, saved.pr_body);
  const report = result.summary.reasons.join("\n");
  assert.match(report, /auto-merge disabled/u);
  assert.ok(report.includes(saved.publication!.pullRequest!.url));
  for (const resource of [saved, ...attempts]) {
    assert.ok(report.includes(resource.branch));
    for (const file of [
      resource.worktree,
      resource.probe!.path,
      resource.invocation!.path,
    ]) {
      await access(file);
      assert.ok(report.includes(file));
    }
  }
  assert.equal(fixture.state.ticket.state, "open");
  assert.ok(fixture.state.ticket.labels!.includes("sandcastle:reserved"));
  for (const file of fixture.state.gitConfigs)
    await assert.rejects(access(file));
});

await test("cancellation during a Review fix retains and reports necessary findings and both role assignments", async (t) => {
  const fixture = await reviewRun(t, 1);
  fixture.reviewState.onReview = findings;
  fixture.reviewState.onFix = async (round) => {
    await writeFile(`${round.fix!.invocation!.path}.tmp`, "unfinished fix");
    fixture.controller.abort();
  };
  assert.equal((await fixture.run()).summary.outcome, "cancelled");
  const saved = await fixture.snapshot();
  const round = saved.reviews![0]!;
  const report = fixture.dependencies.messages
    .filter((message) => message.startsWith("Retained "))
    .join("\n");
  for (const file of [
    round.findings,
    round.probe!.path,
    round.invocation!.path,
    `${round.fix!.invocation!.path}.tmp`,
  ]) {
    await access(file);
    assert.ok(report.includes(file));
  }
  assert.equal(
    await readFile(round.findings, "utf8"),
    "Fix the missing accepted behavior.\n",
  );
  assert.equal(saved.phase, "fixing_review");
  assert.equal(saved.roles.review!.sessionid, "review-native/$&");
});

await test("cancelled documentation reports its Maintenance Ticket checkpoint and execution artifacts", async (t) => {
  const fixture = await documentationRun(t);
  fixture.state.onTask = async (file) => {
    await writeFile(`${file}.tmp`, "unfinished documentation");
    fixture.controller.abort();
  };
  assert.equal((await fixture.run()).summary.outcome, "cancelled");
  assert.equal(fixture.maintenance.cleanup.length, 0);
  const saved = await fixture.snapshot();
  const report = fixture.dependencies.messages
    .filter((message) => message.startsWith("Retained "))
    .join("\n");
  assert.match(report, /-document\.json/u);
  assert.match(report, /-document-50\.json/u);
  for (const file of [
    saved.worktree,
    saved.probe!.path,
    `${saved.invocation!.path}.tmp`,
  ]) {
    await access(file);
    assert.ok(report.includes(file));
  }
  assert.equal(saved.purpose, "documentation");
  for (const file of fixture.state.gitConfigs)
    await assert.rejects(access(file));
});
