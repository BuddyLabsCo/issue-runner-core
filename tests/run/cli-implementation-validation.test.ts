/* eslint-disable @typescript-eslint/require-await -- Scripted external boundaries. */
import assert from "node:assert/strict";
import { access, readFile, writeFile } from "node:fs/promises";
import test from "node:test";
import {
  committed,
  implementationRun,
  publish,
} from "../support/implementation-run.ts";
import { validConfig } from "../support/cli-project.ts";

await test("unexpected Probe fields cannot establish identity or dispatch implementation", async (t) => {
  const fixture = await implementationRun(t);
  fixture.state.onProbe = async (assignment) => {
    await publish(String(assignment.path), {
      ticket: 999,
      sessionid: "native-identity",
      pr_title: "title",
      pr_body: "body",
    });
  };
  fixture.state.onSleep = async (ms) => {
    if (ms === 250) fixture.controller.abort();
  };
  assert.equal((await fixture.run()).summary.outcome, "cancelled");
  assert.equal(fixture.state.taskCount, 0);
  assert.equal((await fixture.snapshot()).roles.implement, undefined);
  assert.equal(fixture.state.events.includes("close"), false);
  assert.match(
    fixture.dependencies.messages.join("\n"),
    /Probe requires actual native identity/,
  );
});

for (const invalid of [
  "run_id",
  "role",
  "sessionid",
  "pr_title",
  "pr_body",
] as const) {
  await test(`Probe rejects invalid ${invalid} before task submission`, async (t) => {
    const fixture = await implementationRun(t);
    fixture.state.onProbe = async (assignment) => {
      await publish(String(assignment.path), {
        sessionid: "native-session",
        pr_title: "Title",
        pr_body: "Body",
        [invalid]: invalid === "sessionid" ? "latest" : "",
      });
    };
    fixture.state.onSleep = async (ms) => {
      if (ms === 250) fixture.controller.abort();
    };
    assert.equal((await fixture.run()).summary.outcome, "cancelled");
    assert.equal(fixture.state.taskCount, 0);
    assert.equal((await fixture.snapshot()).roles.implement, undefined);
  });
}

await test("temporary output and missing final output keep the native conversation incomplete without reminders", async (t) => {
  const fixture = await implementationRun(t);
  fixture.state.onTask = async (file) => {
    await writeFile(`${file}.tmp`, JSON.stringify(committed()));
  };
  let polls = 0;
  fixture.state.onSleep = async (ms) => {
    if (ms === 250 && ++polls === 3) fixture.controller.abort();
  };
  assert.equal((await fixture.run()).summary.outcome, "cancelled");
  assert.equal(fixture.state.submissions.length, 3);
  assert.equal(fixture.state.events.includes("close"), false);
  assert.equal((await fixture.snapshot()).phase, "implementing");
  assert.equal((await fixture.snapshot()).corrections, 0);
  assert.deepEqual((await fixture.snapshot()).superseded, []);
  assert.ok(await readFile(`${fixture.state.expectedPath}.tmp`, "utf8"));
  await assert.rejects(access(fixture.state.gitConfigs[0]!));
});

await test("an extra legacy field gets a bounded correction at a fresh durable path without another startup", async (t) => {
  const fixture = await implementationRun(t);
  let firstPath = "";
  fixture.state.onTask = async (file) => {
    firstPath = file;
    fixture.state.evidence.commits = committed().commits;
    await publish(file, { ...committed(), checks: [] });
  };
  fixture.state.onCorrection = async (file) => {
    const progress = await fixture.snapshot();
    assert.notEqual(file, firstPath);
    assert.equal(progress.corrections, 1);
    assert.deepEqual(progress.superseded, [firstPath]);
    await publish(firstPath, committed());
    await publish(file, committed());
  };
  assert.equal((await fixture.run()).summary.outcome, "incomplete");
  assert.equal((await fixture.snapshot()).phase, "implementation_completed");
  assert.deepEqual(
    fixture.state.sleeps.filter((ms) => ms !== 30_000),
    [10_000, 2_000],
  );
  assert.equal(fixture.state.taskCount, 1);
  assert.equal(fixture.state.probeCount, 1);
});

await test("after correction capacity is exhausted a manual overwrite can complete the current invocation", async (t) => {
  const fixture = await implementationRun(t, { ...validConfig, agentRetry: 0 });
  fixture.state.onTask = async (file) => {
    fixture.state.evidence.commits = committed().commits;
    await publish(file, { ...committed(), outcome: "blocked" });
  };
  fixture.state.onSleep = async (ms) => {
    if (ms === 250) await publish(fixture.state.expectedPath, committed());
  };
  assert.equal((await fixture.run()).summary.outcome, "incomplete");
  assert.equal(fixture.state.submissions.length, 3);
  assert.equal((await fixture.snapshot()).corrections, 0);
  assert.equal((await fixture.snapshot()).phase, "implementation_completed");
});

await test("cancellation during correction backoff retains the consumed budget and prevents follow-up input", async (t) => {
  const fixture = await implementationRun(t);
  fixture.state.onTask = async (file) => {
    await publish(file, { ...committed(), blocker: null });
  };
  fixture.state.onSleep = async (ms) => {
    if (ms === 2_000) fixture.controller.abort();
  };
  assert.equal((await fixture.run()).summary.outcome, "cancelled");
  assert.equal(fixture.state.submissions.length, 3);
  assert.equal((await fixture.snapshot()).corrections, 1);
  assert.equal((await fixture.snapshot()).phase, "implementing");
});

for (const mismatch of [
  "branch",
  "base",
  "worktree",
  "dirty",
  "commits",
] as const) {
  await test(`independent ${mismatch} evidence rejects a false committed handoff`, async (t) => {
    const fixture = await implementationRun(t, {
      ...validConfig,
      agentRetry: 0,
    });
    fixture.state.onTask = async (file) => {
      fixture.state.evidence.commits = committed().commits;
      if (mismatch === "dirty") fixture.state.evidence.clean = false;
      else if (mismatch === "commits") fixture.state.evidence.commits = [];
      else fixture.state.evidence[mismatch] = "wrong";
      await publish(file, committed());
    };
    fixture.state.onSleep = async (ms) => {
      if (ms === 250) fixture.controller.abort();
    };
    assert.equal((await fixture.run()).summary.outcome, "cancelled");
    assert.equal((await fixture.snapshot()).phase, "implementing");
    assert.equal(fixture.state.events.includes("close"), false);
  });
}

await test("verified no_change completes a local stage without delivery credit", async (t) => {
  const fixture = await implementationRun(t);
  fixture.state.onTask = async (file) => {
    await publish(file, {
      outcome: "no_change",
      summary: "No changes required.",
      commits: [],
      findings_file: null,
    });
  };
  const result = await fixture.run();
  assert.equal(result.summary.outcome, "incomplete");
  assert.match(
    result.summary.reasons.join(" "),
    /no_change.*no Issue delivery/,
  );
  assert.equal((await fixture.snapshot()).phase, "implementation_completed");
});

await test("manual republication can retry unchanged result text after correcting the actual Git state", async (t) => {
  const fixture = await implementationRun(t, { ...validConfig, agentRetry: 0 });
  let branch = "";
  let polls = 0;
  fixture.state.onTask = async (file) => {
    branch = fixture.state.evidence.branch;
    fixture.state.evidence.branch = "wrong-branch";
    fixture.state.evidence.commits = committed().commits;
    await publish(file, committed());
  };
  fixture.state.onSleep = async (ms) => {
    if (ms !== 250) return;
    if (++polls === 1) {
      fixture.state.evidence.branch = branch;
      await publish(fixture.state.expectedPath, committed());
    } else if (polls === 3) fixture.controller.abort();
  };
  assert.equal((await fixture.run()).summary.outcome, "incomplete");
  assert.equal((await fixture.snapshot()).phase, "implementation_completed");
});
