/* eslint-disable @typescript-eslint/require-await -- Scripted external boundaries. */
import assert from "node:assert/strict";
import { access, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { executeCli } from "../../src/cli.ts";
import { validConfig } from "../support/cli-project.ts";
import {
  committed,
  implementationProgress,
  publish,
} from "../support/implementation-run.ts";
import {
  batchDocumentationRun,
  documentationNoChange,
} from "../support/batch-documentation-run.ts";
import { child, parentRun } from "../support/parent-run.ts";
import { otherCheckpoint, updateConfig } from "../support/run-scope.ts";

await test("a Parent Run resumes after unrelated configuration and equivalent CLI spelling changes", async (t) => {
  const fixture = await parentRun(t, [child(50)], {
    ...validConfig,
    issueList: [50],
    maxBatchSize: 1,
  });
  const submit = fixture.dependencies.terminalPlugin.onInput.bind(
    fixture.dependencies.terminalPlugin,
  );
  fixture.dependencies.terminalPlugin.onInput = async (tab, text, chord) => {
    if (text.startsWith("Implementation assignment\n")) {
      fixture.controller.abort();
      return;
    }
    await submit(tab, text, chord);
  };
  assert.equal((await fixture.run()).summary.outcome, "cancelled");
  const saved = await implementationProgress(fixture.directory, 50);
  await updateConfig(fixture, (config) => ({
    ...config,
    timeouts: { requiredChecksMinutes: 5, mergeQueueMinutes: 5 },
    maxBatchSize: 2,
  }));
  const controller = new AbortController();
  fixture.dependencies.signal = controller.signal;
  const submissions: string[] = [];
  fixture.dependencies.terminalPlugin.onInput = async (tab, text, chord) => {
    submissions.push(text);
    await submit(tab, text, chord);
    if (text === "continue") controller.abort();
  };

  const result = await executeCli(
    ["run", "--parent=48", "--project", "demo"],
    fixture.dependencies,
  );

  assert.equal(
    result.summary.outcome,
    "cancelled",
    JSON.stringify(result.summary),
  );
  assert.deepEqual(submissions.slice(0, 2), [
    `any-cli --resume "${saved.roles.implement!.sessionid}"`,
    "continue",
  ]);
  assert.equal(
    (await implementationProgress(fixture.directory, 50)).execution_id,
    saved.execution_id,
  );
});

for (const change of [
  "Parent Ticket",
  "configured Issue list",
  "repository",
  "checkout",
  "target branch",
] as const) {
  await test(`a changed ${change} starts a new Parent processing scope and retains old resources`, async (t) => {
    const tickets = [child(50)];
    const fixture = await parentRun(t, tickets, {
      ...validConfig,
      issueList: [50],
      maxBatchSize: 1,
    });
    const submit = fixture.dependencies.terminalPlugin.onInput.bind(
      fixture.dependencies.terminalPlugin,
    );
    fixture.dependencies.terminalPlugin.onInput = async (tab, text, chord) => {
      if (text.startsWith("Implementation assignment\n")) {
        fixture.controller.abort();
        return;
      }
      await submit(tab, text, chord);
    };
    assert.equal((await fixture.run()).summary.outcome, "cancelled");
    const saved = await implementationProgress(fixture.directory, 50);
    const oldFile = path.join(
      fixture.directory,
      "recovery",
      `${saved.input_hash}-50.json`,
    );
    const oldText = await readFile(oldFile, "utf8");
    tickets[0]!.labels = ["ready-for-agent"];
    tickets[0]!.assignees = [];
    await updateConfig(fixture, (config) => ({
      ...config,
      ...(change === "configured Issue list"
        ? { issueList: [50, 51] }
        : change === "repository"
          ? { repository: "owner/other" }
          : change === "checkout"
            ? { checkout: path.resolve(tmpdir(), "other-checkout") }
            : change === "target branch"
              ? { targetBranch: "other-branch" }
              : {}),
    }));
    if (change === "repository") tickets[0]!.repository = "owner/other";
    const controller = new AbortController();
    fixture.dependencies.signal = controller.signal;
    fixture.dependencies.terminalPlugin.onInput = async (tab, text, chord) => {
      if (text.startsWith("Implementation assignment\n")) {
        controller.abort();
        return;
      }
      await submit(tab, text, chord);
    };
    const result = await executeCli(
      [
        "run",
        "--project",
        "demo",
        "--parent",
        change === "Parent Ticket" ? "49" : "48",
      ],
      fixture.dependencies,
    );

    assert.equal(
      result.summary.outcome,
      "cancelled",
      JSON.stringify(result.summary),
    );
    const current = (await otherCheckpoint(fixture.directory, saved.input_hash))
      .progress;
    assert.notEqual(current.execution_id, saved.execution_id);
    assert.equal(await readFile(oldFile, "utf8"), oldText);
    await access(saved.worktree);
  });
}

await test("changing Parent Review participation starts a new processing scope", async (t) => {
  const tickets = [child(50)];
  const fixture = await parentRun(t, tickets, {
    ...validConfig,
    issueList: [50],
    maxBatchSize: 1,
  });
  const submit = fixture.dependencies.terminalPlugin.onInput.bind(
    fixture.dependencies.terminalPlugin,
  );
  fixture.dependencies.terminalPlugin.onInput = async (tab, text, chord) => {
    if (text.startsWith("Implementation assignment\n")) {
      fixture.controller.abort();
      return;
    }
    await submit(tab, text, chord);
  };
  assert.equal((await fixture.run()).summary.outcome, "cancelled");
  const saved = await implementationProgress(fixture.directory, 50);
  tickets[0]!.labels = ["ready-for-agent"];
  tickets[0]!.assignees = [];
  await updateConfig(fixture, (config) => ({
    ...config,
    workflow: { review: true },
  }));
  const controller = new AbortController();
  fixture.dependencies.signal = controller.signal;
  fixture.dependencies.terminalPlugin.onInput = async (tab, text, chord) => {
    if (text.startsWith("Implementation assignment\n")) {
      controller.abort();
      return;
    }
    await submit(tab, text, chord);
  };

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

await test("changing Parent maxReviewRounds while Review is enabled starts a new scope", async (t) => {
  const tickets = [child(50)];
  const fixture = await parentRun(t, tickets, {
    ...validConfig,
    issueList: [50],
    maxBatchSize: 1,
    workflow: { review: true, maxReviewRounds: 1 },
  });
  const submit = fixture.dependencies.terminalPlugin.onInput.bind(
    fixture.dependencies.terminalPlugin,
  );
  fixture.dependencies.terminalPlugin.onInput = async (tab, text, chord) => {
    if (text.startsWith("Implementation assignment\n")) {
      fixture.controller.abort();
      return;
    }
    await submit(tab, text, chord);
  };
  assert.equal((await fixture.run()).summary.outcome, "cancelled");
  const saved = await implementationProgress(fixture.directory, 50);
  tickets[0]!.labels = ["ready-for-agent"];
  tickets[0]!.assignees = [];
  await updateConfig(fixture, (config) => ({
    ...config,
    workflow: { review: true, maxReviewRounds: 2 },
  }));
  const controller = new AbortController();
  fixture.dependencies.signal = controller.signal;
  fixture.dependencies.terminalPlugin.onInput = async (tab, text, chord) => {
    if (text.startsWith("Implementation assignment\n")) {
      controller.abort();
      return;
    }
    await submit(tab, text, chord);
  };

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

await test("resumed Parent work uses the current required-checks timeout", async (t) => {
  const fixture = await parentRun(t, [child(50)], {
    ...validConfig,
    maxBatchSize: 1,
  });
  const submit = fixture.dependencies.terminalPlugin.onInput.bind(
    fixture.dependencies.terminalPlugin,
  );
  fixture.dependencies.terminalPlugin.onInput = async (tab, text, chord) => {
    if (text.startsWith("Implementation assignment\n")) {
      fixture.controller.abort();
      return;
    }
    await submit(tab, text, chord);
  };
  assert.equal((await fixture.run()).summary.outcome, "cancelled");
  const saved = await implementationProgress(fixture.directory, 50);
  await updateConfig(fixture, (config) => ({
    ...config,
    timeouts: { requiredChecksMinutes: 0.25, mergeQueueMinutes: 5 },
  }));
  const controller = new AbortController();
  fixture.dependencies.signal = controller.signal;
  const inspect = fixture.dependencies.gitWorkspace.inspect.bind(
    fixture.dependencies.gitWorkspace,
  );
  fixture.dependencies.gitWorkspace.inspect = async (input) => ({
    ...(await inspect(input)),
    changed: true,
    commits: committed(50).commits,
  });
  fixture.dependencies.terminalPlugin.onInput = async (tab, text, chord) => {
    await submit(tab, text, chord);
    if (text === "continue")
      await publish(saved.invocation!.path, committed(50));
  };
  const sleeps: number[] = [];
  let now = fixture.dependencies.clock.now().getTime();
  fixture.dependencies.clock.now = () => new Date(now);
  fixture.dependencies.clock.sleep = async (ms) => {
    now += ms;
    sleeps.push(ms);
    if (sleeps.length === 6) controller.abort();
  };
  fixture.dependencies.codeHost.checksFor = async () => [
    { name: "build", state: "PENDING", link: "", bucket: "pending" },
  ];
  let pause: string | undefined;
  fixture.dependencies.operator.pause = async (message) => {
    pause = message;
    return "q";
  };

  const result = await fixture.run();

  assert.equal(result.summary.outcome, "cancelled", JSON.stringify(result));
  assert.match(pause ?? "", /Required checks timed out/u);
  assert.deepEqual(
    sleeps.filter((ms) => ms !== 250),
    [10_000, 30_000, 10_000, 5_000],
  );
});

await test("a Parent Batch interrupted during Documentation recovers after an equivalent CLI spelling change", async (t) => {
  const fixture = await batchDocumentationRun(t, [
    child(51, { labels: ["ready-for-agent", "Docs"] }),
  ]);
  fixture.state.onDocument = async () => {
    fixture.controller.abort();
  };
  assert.equal((await fixture.run()).summary.outcome, "cancelled");
  const original = await implementationProgress(fixture.directory, 100);
  fixture.dependencies.signal = new AbortController().signal;
  const submit = fixture.dependencies.terminalPlugin.onInput.bind(
    fixture.dependencies.terminalPlugin,
  );
  fixture.dependencies.terminalPlugin.onInput = async (tab, text) => {
    await submit(tab, text);
    if (text === "continue")
      await publish(original.invocation!.path, documentationNoChange);
  };

  const result = await executeCli(
    ["run", "--project", "demo", "--parent=48"],
    fixture.dependencies,
  );

  assert.equal(result.summary.outcome, "succeeded", JSON.stringify(result));
  assert.equal(
    (await implementationProgress(fixture.directory, 100)).execution_id,
    original.execution_id,
  );
});
