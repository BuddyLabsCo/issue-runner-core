/* eslint-disable @typescript-eslint/require-await -- Scripted external boundaries. */
import assert from "node:assert/strict";
import {
  access,
  appendFile,
  readFile,
  readdir,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { parse, stringify } from "yaml";
import { executeCli } from "../../src/cli.ts";
import {
  implementationProgress,
  implementationRun,
  publish,
} from "../support/implementation-run.ts";
import { child, parentRun } from "../support/parent-run.ts";
import { validConfig } from "../support/cli-project.ts";
import { ciRepairRun } from "../support/ci-repair-run.ts";
import {
  assertRecovered,
  continueWith,
  interrupt,
  interruptNextAssignment,
  otherCheckpoint,
  updateConfig,
} from "../support/run-scope.ts";

await test("an explicit Issue resumes after YAML-only, timeout, prompt, and Agent start changes", async (t) => {
  const fixture = await implementationRun(t);
  const saved = await interrupt(fixture);
  assert.deepEqual(saved.roles.implement, {
    sessionid: "native/$&/$`/$'/session",
    agent: validConfig.agents.implement.agent,
    resume: validConfig.agents.implement.resume.replaceAll(
      "{sessionref}",
      () => "native/$&/$`/$'/session",
    ),
  });
  const file = path.join(fixture.directory, "config.yaml");
  const config = parse(await readFile(file, "utf8")) as Record<string, unknown>;
  const reordered = Object.fromEntries(Object.entries(config).reverse());
  await writeFile(
    file,
    `# Configuration was reformatted while the Issue was interrupted\n${stringify(
      {
        ...reordered,
        timeouts: { requiredChecksMinutes: 5, mergeQueueMinutes: 5 },
      },
    )}`,
  );
  await appendFile(
    path.join(fixture.directory, "prompts", "implement.md"),
    "\nChanged prompt.\n",
  );
  await updateConfig(fixture, (current) => ({
    ...current,
    agents: {
      ...(current.agents as Record<string, unknown>),
      implement: {
        ...(current.agents as Record<string, Record<string, unknown>>)
          .implement,
        start: "changed-start-command",
      },
    },
  }));
  await assertRecovered(fixture, saved);
});

await test("a new session after recovery uses the current Agent configuration", async (t) => {
  const fixture = await implementationRun(t, {
    ...validConfig,
    workflow: { review: true },
  });
  const saved = await interrupt(fixture);
  await updateConfig(fixture, (config) => ({
    ...config,
    agents: {
      ...(config.agents as Record<string, unknown>),
      review: {
        ...(config.agents as Record<string, Record<string, unknown>>).review,
        start: "changed-review-start",
      },
    },
  }));
  const before = continueWith(fixture, saved);
  const controller = new AbortController();
  fixture.dependencies.signal = controller.signal;
  const commands: string[] = [];
  const execute = fixture.dependencies.terminalPlugin.execute.bind(
    fixture.dependencies.terminalPlugin,
  );
  fixture.dependencies.terminalPlugin.execute = async (tab, command) => {
    commands.push(command);
    if (command === "changed-review-start") controller.abort();
    return execute(tab, command);
  };
  const result = await fixture.run();
  assert.equal(result.summary.outcome, "cancelled", result.summary.failure);
  assert.ok(commands.includes("changed-review-start"));
  assert.equal(
    fixture.state.submissions[before]?.text,
    'any-cli --resume "native/$&/$`/$\'/session"',
  );
  assert.equal(fixture.state.submissions[before + 1]?.text, "continue");
});

await test("an explicit Issue resumes after equivalent CLI spelling, option order, auto-merge, and command rename", async (t) => {
  const fixture = await implementationRun(t);
  const saved = await interrupt(fixture);
  fixture.dependencies.commandName = "renamed-terminal";
  const controller = new AbortController();
  fixture.dependencies.signal = controller.signal;
  fixture.state.onSleep = async (ms) => {
    if (ms === 250) controller.abort();
  };
  const result = await executeCli(
    ["run", "--auto-merge", "--issue=50", "--project", "demo"],
    fixture.dependencies,
  );
  assert.equal(result.summary.outcome, "cancelled");
  assert.equal((await fixture.snapshot()).execution_id, saved.execution_id);
});

await test("an omitted target branch and its explicit resolution share one scope", async (t) => {
  const fixture = await implementationRun(t);
  const saved = await interrupt(fixture);
  await updateConfig(fixture, (config) => ({
    ...config,
    targetBranch: "default-branch",
  }));
  await assertRecovered(fixture, saved);
});

await test("an explicit Issue ignores changes to the configured Issue list", async (t) => {
  const fixture = await implementationRun(t);
  const saved = await interrupt(fixture);
  await updateConfig(fixture, (config) => ({
    ...config,
    issueList: [51, 52],
  }));
  await assertRecovered(fixture, saved);
});

await test("a satisfied eligibility label change and equivalent checkout spelling recover", async (t) => {
  const fixture = await implementationRun(t);
  const saved = await interrupt(fixture);
  fixture.state.ticket.labels!.push("another-ready-label");
  await updateConfig(fixture, (config) => ({
    ...config,
    issueLabel: "another-ready-label",
    checkout: `${String(config.checkout)}/.`,
  }));
  await assertRecovered(fixture, saved);
});

await test("a case-only repository spelling change recovers", async (t) => {
  const fixture = await implementationRun(t);
  fixture.state.ticket.repository = "owner/repo";
  const saved = await interrupt(fixture);
  await updateConfig(fixture, (config) => ({
    ...config,
    repository: "Owner/Repo",
  }));
  await assertRecovered(fixture, saved);
});

await test("a symlink alias of the checkout shares one scope", async (t) => {
  const fixture = await implementationRun(t);
  const saved = await interrupt(fixture);
  const config = parse(
    await readFile(path.join(fixture.directory, "config.yaml"), "utf8"),
  ) as { checkout: string };
  const link = path.join(fixture.directory, "checkout-link");
  await symlink(
    config.checkout,
    link,
    process.platform === "win32" ? "junction" : "dir",
  );
  await updateConfig(fixture, (current) => ({
    ...current,
    checkout: link,
  }));
  await assertRecovered(fixture, saved);
});

await test("a case-only repository spelling change recovers a value-less Batch", async (t) => {
  const tickets = [child(50)];
  const fixture = await parentRun(t, tickets, {
    ...validConfig,
    issueList: [50],
    maxBatchSize: 1,
  });
  const submit = fixture.dependencies.terminalPlugin.onInput.bind(
    fixture.dependencies.terminalPlugin,
  );
  let shouldInterrupt = true;
  fixture.dependencies.terminalPlugin.onInput = async (tab, text, chord) => {
    if (shouldInterrupt && text.startsWith("Implementation assignment\n")) {
      shouldInterrupt = false;
      fixture.controller.abort();
      return;
    }
    await submit(tab, text, chord);
  };
  assert.equal((await fixture.run(["--issue"])).summary.outcome, "cancelled");
  const saved = await implementationProgress(fixture.directory, 50);
  await updateConfig(fixture, (config) => ({
    ...config,
    repository: "Owner/Repo",
  }));
  tickets[0]!.labels = ["ready-for-agent"];
  tickets[0]!.assignees = [];
  fixture.dependencies.signal = new AbortController().signal;
  assert.notEqual((await fixture.run(["--issue"])).summary.outcome, "failed");
  assert.equal(
    (await implementationProgress(fixture.directory, 50)).execution_id,
    saved.execution_id,
  );
});

for (const change of ["repository", "checkout", "target branch"] as const) {
  await test(`a changed ${change} starts a new processing scope and retains old resources`, async (t) => {
    const fixture = await implementationRun(t);
    const saved = await interrupt(fixture);
    const recovery = path.join(fixture.directory, "recovery");
    const oldFile = path.join(recovery, `${saved.input_hash}-50.json`);
    const oldText = await readFile(oldFile, "utf8");
    await updateConfig(fixture, (config) => ({
      ...config,
      ...(change === "repository"
        ? { repository: "owner/other" }
        : change === "checkout"
          ? { checkout: path.resolve(tmpdir(), "other-checkout") }
          : { targetBranch: "other-branch" }),
    }));
    fixture.state.ticket.labels = ["ready-for-agent"];
    fixture.state.ticket.assignees = [];
    const controller = new AbortController();
    fixture.dependencies.signal = controller.signal;
    interruptNextAssignment(fixture, controller);
    const result = await fixture.run();
    assert.equal(
      result.summary.outcome,
      "cancelled",
      JSON.stringify(result.summary),
    );
    const current = (await otherCheckpoint(fixture.directory, saved.input_hash))
      .progress;
    assert.notEqual(current.execution_id, saved.execution_id);
    assert.notEqual(current.input_hash, saved.input_hash);
    assert.equal(await readFile(oldFile, "utf8"), oldText);
    for (const resource of [saved.worktree, saved.probe!.path]) {
      await access(resource);
    }
    assert.deepEqual(fixture.state.cleanup, []);
  });
}

await test("changing Review participation starts a new processing scope", async (t) => {
  const fixture = await implementationRun(t);
  const saved = await interrupt(fixture);
  await updateConfig(fixture, (config) => ({
    ...config,
    workflow: { review: true },
  }));
  fixture.state.ticket.labels = ["ready-for-agent"];
  fixture.state.ticket.assignees = [];
  const controller = new AbortController();
  fixture.dependencies.signal = controller.signal;
  interruptNextAssignment(fixture, controller);
  const result = await fixture.run();
  assert.equal(
    result.summary.outcome,
    "cancelled",
    JSON.stringify(result.summary),
  );
  assert.notEqual(
    (await otherCheckpoint(fixture.directory, saved.input_hash)).progress
      .execution_id,
    saved.execution_id,
  );
});

await test("changing maxReviewRounds only changes scope while Review is enabled", async (t) => {
  const enabled = await implementationRun(t, {
    ...validConfig,
    workflow: { review: true, maxReviewRounds: 1 },
  });
  const enabledSaved = await interrupt(enabled);
  await updateConfig(enabled, (config) => ({
    ...config,
    workflow: { review: true, maxReviewRounds: 2 },
  }));
  enabled.state.ticket.labels = ["ready-for-agent"];
  enabled.state.ticket.assignees = [];
  const enabledController = new AbortController();
  enabled.dependencies.signal = enabledController.signal;
  interruptNextAssignment(enabled, enabledController);
  const enabledResult = await enabled.run();
  assert.equal(
    enabledResult.summary.outcome,
    "cancelled",
    JSON.stringify(enabledResult.summary),
  );
  assert.notEqual(
    (await otherCheckpoint(enabled.directory, enabledSaved.input_hash)).progress
      .execution_id,
    enabledSaved.execution_id,
  );

  const disabled = await implementationRun(t);
  const disabledSaved = await interrupt(disabled);
  await updateConfig(disabled, (config) => ({
    ...config,
    workflow: { review: false, maxReviewRounds: 2 },
  }));
  await assertRecovered(disabled, disabledSaved);
});

for (const [field, value] of [
  ["agent", "another-agent"],
  ["resume", 'another-cli --resume "{sessionref}"'],
] as const) {
  await test(`a changed recorded ${field} value requires an explicit restart`, async (t) => {
    const fixture = await implementationRun(t);
    const saved = await interrupt(fixture);
    await publish(saved.invocation!.path, {});
    await updateConfig(fixture, (config) => ({
      ...config,
      agents: {
        ...(config.agents as Record<string, unknown>),
        implement: {
          ...(config.agents as Record<string, Record<string, unknown>>)
            .implement,
          [field]: value,
        },
      },
    }));
    fixture.dependencies.operator.pause = async (message) => {
      assert.equal(
        message,
        "Enter to restart the entire Issue #50, or q to exit Runner.",
      );
      return "q";
    };
    const result = await fixture.run();
    assert.equal(result.summary.outcome, "cancelled", result.summary.failure);
    assert.ok(fixture.dependencies.messages.includes("unable to recover"));
    await access(saved.worktree);
    await access(saved.probe!.path);
    await access(saved.invocation!.path);
    assert.deepEqual(fixture.state.cleanup, []);
    assert.equal(
      await fixture.snapshot().then((item) => item.run_id),
      saved.run_id,
    );
  });
}

await test("a changed Agent identity for a role without a recorded conversation recovers", async (t) => {
  const fixture = await implementationRun(t);
  const saved = await interrupt(fixture);
  await updateConfig(fixture, (config) => ({
    ...config,
    agents: {
      ...(config.agents as Record<string, unknown>),
      review: {
        ...(config.agents as Record<string, Record<string, unknown>>).review,
        agent: "another-review-agent",
      },
    },
  }));
  await assertRecovered(fixture, saved);
});

await test("a changed recorded repair Agent identity requires an explicit restart", async (t) => {
  const fixture = await ciRepairRun(t);
  fixture.repairs.onTask = async () => fixture.controller.abort();
  assert.equal((await fixture.run()).summary.outcome, "cancelled");
  const saved = await fixture.snapshot();
  const attempt = saved.publication!.ciRepair!.attempts.at(-1)!;
  assert.equal(attempt.agent, validConfig.agents.ciRepair.agent);
  assert.equal(
    attempt.resume,
    validConfig.agents.ciRepair.resume.replaceAll(
      "{sessionref}",
      () => attempt.sessionid!,
    ),
  );
  await updateConfig(fixture, (config) => ({
    ...config,
    agents: {
      ...(config.agents as Record<string, unknown>),
      ciRepair: {
        ...(config.agents as Record<string, Record<string, unknown>>).ciRepair,
        resume: 'another-repair-cli --resume "{sessionref}"',
      },
    },
  }));
  fixture.dependencies.signal = new AbortController().signal;
  fixture.dependencies.operator.pause = async () => "q";
  const result = await fixture.run();
  assert.equal(
    result.summary.outcome,
    "cancelled",
    JSON.stringify(result.summary),
  );
  assert.ok(fixture.dependencies.messages.includes("unable to recover"));
  const restored = await fixture.snapshot();
  assert.deepEqual(restored.publication, saved.publication);
  await access(attempt.worktree);
});

await test("old-format checkpoints are ignored rather than adopted", async (t) => {
  const fixture = await implementationRun(t);
  const saved = await interrupt(fixture);
  const recovery = path.join(fixture.directory, "recovery");
  const currentFile = path.join(recovery, `${saved.input_hash}-50.json`);
  const oldHash = "0".repeat(64);
  const oldFile = path.join(recovery, `${oldHash}-50.json`);
  const old = {
    ...saved,
    input_hash: oldHash,
    checkpoint_version: undefined,
    run_scope: undefined,
  };
  const oldText = JSON.stringify(old);
  await writeFile(oldFile, oldText);
  await rm(currentFile);
  fixture.state.ticket.labels = ["ready-for-agent"];
  fixture.state.ticket.assignees = [];
  const controller = new AbortController();
  fixture.dependencies.signal = controller.signal;
  interruptNextAssignment(fixture, controller);
  const result = await fixture.run();
  assert.equal(
    result.summary.outcome,
    "cancelled",
    JSON.stringify(result.summary),
  );
  const current = (await otherCheckpoint(fixture.directory, oldHash)).progress;
  assert.notEqual(current.execution_id, saved.execution_id);
  assert.equal(await readFile(oldFile, "utf8"), oldText);
  await access(saved.worktree);
  assert.deepEqual(fixture.state.cleanup, []);
});

await test("a value-less Issue selection starts a new scope when its configured list changes", async (t) => {
  const tickets = [child(50), child(51)];
  const fixture = await parentRun(t, tickets, {
    ...validConfig,
    issueList: [50],
    maxBatchSize: 1,
  });
  const submit = fixture.dependencies.terminalPlugin.onInput.bind(
    fixture.dependencies.terminalPlugin,
  );
  let interrupt = true;
  fixture.dependencies.terminalPlugin.onInput = async (tab, text, chord) => {
    if (interrupt && text.startsWith("Implementation assignment\n")) {
      interrupt = false;
      fixture.controller.abort();
      return;
    }
    await submit(tab, text, chord);
  };
  assert.equal((await fixture.run(["--issue"])).summary.outcome, "cancelled");
  const recovery = path.join(fixture.directory, "recovery");
  const oldFile = (await readdir(recovery)).find((name) =>
    name.endsWith("-50.json"),
  )!;
  const old = JSON.parse(
    await readFile(path.join(recovery, oldFile), "utf8"),
  ) as { input_hash: string; worktree: string };
  const oldText = await readFile(path.join(recovery, oldFile), "utf8");
  await updateConfig(fixture, (config) => ({
    ...config,
    issueList: [50, 51],
  }));
  tickets[0]!.labels = ["ready-for-agent"];
  tickets[0]!.assignees = [];
  fixture.dependencies.signal = new AbortController().signal;
  const changed = await fixture.run(["--issue"]);
  assert.notEqual(changed.summary.outcome, "failed");
  const current = await otherCheckpoint(fixture.directory, old.input_hash);
  assert.notEqual(current.progress.execution_id, undefined);
  assert.equal(await readFile(path.join(recovery, oldFile), "utf8"), oldText);
  await access(old.worktree);
});
