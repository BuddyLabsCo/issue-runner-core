import assert from "node:assert/strict";
import {
  readFile,
  readdir,
  rename,
  stat,
  utimes,
  writeFile,
} from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { validConfig } from "../support/cli-project.ts";
import {
  committed,
  implementationRun,
  publish,
} from "../support/implementation-run.ts";

await test("a final published before observation wins over temporary and unrelated files", async (t) => {
  const fixture = await implementationRun(t);
  fixture.state.onTask = async (file) => {
    fixture.state.evidence.commits = committed().commits;
    await publish(file, { ...committed(), summary: "Assigned final." });
    await writeFile(`${file}.tmp`, "{");
    await publish(path.join(path.dirname(file), "unrelated.json"), {});
  };
  assert.equal((await fixture.run()).summary.outcome, "incomplete");
  const saved = await fixture.snapshot();
  assert.equal(saved.phase, "implementation_completed");
  assert.equal(saved.result?.summary, "Assigned final.");
  assert.equal(saved.corrections, 0);
  assert.deepEqual(
    fixture.state.sleeps.filter((ms) => ms !== 30_000),
    [10_000],
  );
  assert.equal(fixture.state.closedTabs.length, 1);
});

await test("polling finds an atomic publication without any filesystem notification", async (t) => {
  const fixture = await implementationRun(t);
  fixture.state.onTask = async (file) => {
    fixture.state.evidence.commits = committed().commits;
    await writeFile(
      `${file}.tmp`,
      JSON.stringify({ ...committed(), summary: "Published between polls." }),
    );
    await publish(
      path.join(path.dirname(file), "other-invocation.json"),
      committed(),
    );
  };
  let polls = 0;
  fixture.state.onSleep = async (ms) => {
    if (ms !== 250) return;
    assert.ok(++polls <= 2);
    const saved = await fixture.snapshot();
    assert.equal(saved.phase, "implementing");
    assert.equal(saved.result, undefined);
    assert.equal(saved.corrections, 0);
    assert.equal(fixture.state.closedTabs.length, 0);
    if (polls === 2)
      await rename(
        `${fixture.state.expectedPath}.tmp`,
        fixture.state.expectedPath,
      );
  };
  assert.equal((await fixture.run()).summary.outcome, "incomplete");
  assert.equal(
    (await fixture.snapshot()).result?.summary,
    "Published between polls.",
  );
  assert.equal(polls, 2);
  assert.equal(fixture.state.taskCount, 1);
  assert.equal(fixture.state.submissions.length, 3);
});

await test("partial and same-size manual replacements remain active with colliding modification times", async (t) => {
  const fixture = await implementationRun(t, { ...validConfig, agentRetry: 0 });
  const timestamp = new Date("2026-10-30T00:00:00.000Z");
  const invalid = { ...committed(), outcome: "no_change" };
  assert.equal(
    JSON.stringify(invalid).length,
    JSON.stringify(committed()).length,
  );
  fixture.state.onTask = async (file) => {
    fixture.state.evidence.commits = committed().commits;
    await writeFile(file, "{");
    await utimes(file, timestamp, timestamp);
  };
  let polls = 0;
  fixture.state.onSleep = async (ms) => {
    if (ms !== 250) return;
    assert.ok(++polls <= 3);
    assert.equal((await fixture.snapshot()).phase, "implementing");
    assert.equal(fixture.state.closedTabs.length, 0);
    const file = fixture.state.expectedPath;
    if (polls === 1) await writeFile(file, JSON.stringify(invalid));
    else if (polls === 2) await publish(file, invalid);
    else await publish(file, committed());
    await utimes(file, timestamp, timestamp);
    assert.equal((await stat(file)).mtimeMs, timestamp.getTime());
  };
  assert.equal((await fixture.run()).summary.outcome, "incomplete");
  const saved = await fixture.snapshot();
  assert.equal(saved.phase, "implementation_completed");
  assert.equal(saved.invocation?.path, fixture.state.expectedPath);
  assert.equal(saved.corrections, 0);
  assert.deepEqual(saved.superseded, []);
  assert.equal(polls, 3);
  assert.equal(fixture.state.submissions.length, 3);
});

await test("an identical handoff can be resubmitted after correcting independent Git evidence", async (t) => {
  const fixture = await implementationRun(t, { ...validConfig, agentRetry: 0 });
  fixture.state.onTask = async (file) => {
    fixture.state.evidence.commits = committed().commits;
    fixture.state.evidence.clean = false;
    await publish(file, committed());
  };
  let polls = 0;
  fixture.state.onSleep = async (ms) => {
    if (ms !== 250) return;
    assert.equal(++polls, 1);
    assert.equal((await fixture.snapshot()).result, undefined);
    fixture.state.evidence.clean = true;
    await publish(fixture.state.expectedPath, committed());
  };
  assert.equal((await fixture.run()).summary.outcome, "incomplete");
  assert.equal((await fixture.snapshot()).phase, "implementation_completed");
  assert.match(
    fixture.dependencies.messages.join("\n"),
    /Worktree must be clean/,
  );
  assert.equal(fixture.state.submissions.length, 3);
});

await test("a superseded final cannot satisfy a correction while its active result is temporary", async (t) => {
  const fixture = await implementationRun(t);
  let superseded = "";
  fixture.state.onTask = async (file) => {
    superseded = file;
    fixture.state.evidence.commits = committed().commits;
    await writeFile(file, "{");
  };
  fixture.state.onCorrection = async (file) => {
    assert.notEqual(file, superseded);
    await publish(superseded, {
      ...committed(),
      summary: "Superseded submission.",
    });
    await writeFile(
      `${file}.tmp`,
      JSON.stringify({ ...committed(), summary: "Active correction." }),
    );
  };
  let polls = 0;
  fixture.state.onSleep = async (ms) => {
    if (ms !== 250) return;
    assert.equal(++polls, 1);
    const saved = await fixture.snapshot();
    assert.equal(saved.phase, "implementing");
    assert.equal(saved.result, undefined);
    assert.equal(saved.corrections, 1);
    assert.deepEqual(saved.superseded, [superseded]);
    await rename(
      `${fixture.state.expectedPath}.tmp`,
      fixture.state.expectedPath,
    );
  };
  assert.equal((await fixture.run()).summary.outcome, "incomplete");
  assert.equal(
    (await fixture.snapshot()).result?.summary,
    "Active correction.",
  );
  assert.equal(fixture.state.submissions.length, 4);
  assert.equal(fixture.state.closedTabs.length, 1);
});

await test("overwrites during validation and after acceptance cannot change the consumed result", async (t) => {
  const fixture = await implementationRun(t);
  const inspect = fixture.dependencies.gitWorkspace.inspect.bind(
    fixture.dependencies.gitWorkspace,
  );
  let validations = 0;
  fixture.dependencies.gitWorkspace.inspect = async () => {
    const evidence = await inspect();
    if (fixture.state.taskCount > 0 && fixture.state.closedTabs.length === 0) {
      validations += 1;
      await publish(fixture.state.expectedPath, {
        outcome: "no_change",
        summary: "Replacement during Git verification.",
        commits: [],
        findings_file: null,
      });
    }
    return evidence;
  };
  fixture.state.onClose = async () => {
    assert.deepEqual((await fixture.snapshot()).result, committed());
    await writeFile(fixture.state.expectedPath, "{");
  };
  assert.equal((await fixture.run()).summary.outcome, "incomplete");
  const accepted = await fixture.snapshot();
  assert.deepEqual(accepted.result, committed());
  assert.equal(accepted.phase, "implementation_completed");
  assert.equal(validations, 1);
  assert.equal(fixture.state.closedTabs.length, 1);
  assert.deepEqual(
    fixture.state.sleeps.filter((ms) => ms !== 30_000),
    [10_000],
  );
  assert.equal(await readFile(fixture.state.expectedPath, "utf8"), "{");
  assert.deepEqual(
    (await readdir(path.join(fixture.directory, "handoffs"))).sort(),
    [
      path.basename(accepted.probe!.path),
      path.basename(accepted.invocation!.path),
    ].sort(),
  );
  assert.equal((await fixture.run()).summary.outcome, "incomplete");
  assert.deepEqual((await fixture.snapshot()).result, committed());
  assert.equal(fixture.state.taskCount, 1);
  assert.equal(fixture.state.closedTabs.length, 1);
  assert.deepEqual(
    fixture.state.sleeps.filter((ms) => ms !== 30_000),
    [10_000],
  );
});

await test("concurrent executions with the same timestamp cannot consume each other's submissions", async (t) => {
  const fixtures = await Promise.all([
    implementationRun(t),
    implementationRun(t),
  ]);
  let release!: () => void;
  const ready = new Promise<void>((resolve) => {
    release = resolve;
  });
  const paths: string[] = [];
  for (const [index, fixture] of fixtures.entries()) {
    fixture.state.onTask = async (file) => {
      paths[index] = file;
      fixture.state.evidence.commits = committed().commits;
      if (paths.filter(Boolean).length === 2) release();
      await ready;
      const other = paths[1 - index]!;
      assert.notEqual(path.basename(file), path.basename(other));
      await publish(path.join(path.dirname(file), path.basename(other)), {
        ...committed(),
        summary: `Other execution ${1 - index}.`,
      });
      await writeFile(`${file}.tmp`, JSON.stringify(committed()));
    };
    let polls = 0;
    fixture.state.onSleep = async (ms) => {
      if (ms !== 250) return;
      assert.equal(++polls, 1);
      const saved = await fixture.snapshot();
      assert.equal(saved.phase, "implementing");
      assert.equal(saved.result, undefined);
      assert.equal(saved.corrections, 0);
      await publish(fixture.state.expectedPath, {
        ...committed(),
        summary: `Execution ${index}.`,
      });
    };
  }
  const results = await Promise.all(fixtures.map((fixture) => fixture.run()));
  assert.ok(results.every((result) => result.summary.outcome === "incomplete"));
  for (const [index, fixture] of fixtures.entries()) {
    const saved = await fixture.snapshot();
    assert.equal(saved.result?.summary, `Execution ${index}.`);
    assert.equal(fixture.state.closedTabs.length, 1);
    assert.equal(fixture.state.submissions.length, 3);
  }
});
