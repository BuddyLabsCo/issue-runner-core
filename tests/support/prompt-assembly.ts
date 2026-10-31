/* eslint-disable @typescript-eslint/require-await -- Scripted external boundaries. */
import assert from "node:assert/strict";
import type { TestContext } from "node:test";
import type { executeCli } from "../../src/cli.ts";
import { validConfig } from "./cli-project.ts";
import {
  committed,
  implementationCommand,
  implementationRun,
  publish,
} from "./implementation-run.ts";

export async function testPromptAssembly(
  t: TestContext,
  execute: typeof executeCli,
) {
  const fixture = await implementationRun(t);
  fixture.state.ticket.body =
    "Keep literal $& and {{path}} and Unicode: \u4f60\u597d";
  const probes: Record<string, unknown>[] = [];
  const nativeProbe = fixture.state.onProbe;
  fixture.state.onProbe = async (assignment) => {
    probes.push(assignment);
    if (probes.length === 1)
      await publish(String(assignment.path), { ...assignment, sessionid: "" });
    else await nativeProbe(assignment);
  };
  fixture.state.onTask = async (file) => {
    fixture.state.evidence.commits = committed().commits;
    await publish(file, { ...committed(), findings_file: file });
  };
  assert.equal(
    (await execute(implementationCommand, fixture.dependencies)).summary
      .outcome,
    "incomplete",
  );
  const submissions = fixture.state.submissions;
  assert.equal(submissions.length, 5);
  assert.equal(submissions[0]!.text, validConfig.agents.implement.start);
  assert.equal(submissions[0]!.chord, "Enter");
  for (const [index, assignment] of probes.entries()) {
    assert.equal(
      submissions[index + 1]!.text,
      `Session Probe\n${JSON.stringify(assignment)}\n\n` +
        (index === 1
          ? "Correct the previous Probe: Probe requires actual native identity and complete PR metadata\n"
          : "") +
        "Determine the actual native conversation sessionid from your native CLI context. Never use a generated ID, tab ID, or latest-session alias. " +
        "Inspect the repository's AGENTS.md, contribution instructions and PR conventions. Generate complete pr_title and pr_body for owner/repo#50.\n" +
        "Issue: Implement the Issue\nKeep literal $& and {{path}} and Unicode: \u4f60\u597d\n" +
        `Write exactly the assignment fields above plus sessionid, pr_title, pr_body as JSON to ${String(assignment.path)}.tmp, close it, and atomically rename it to ${String(assignment.path)}. Do not begin the task yet.`,
    );
  }
  const task = submissions[3]!.text;
  assert.ok(
    task.includes(
      "After atomically publishing the handoff, do no further work or Git writes.\n\nProject implement instructions\n\nRepository: owner/repo\nIssue #50: Implement the Issue\nKeep literal $& and {{path}} and Unicode: \u4f60\u597d\nWorktree:",
    ),
  );
  const saved = await fixture.snapshot();
  assert.ok(
    task.endsWith(
      "Fixed PR title: feat: [issue-50] implement the Issue\nFixed PR body:\nImplement the Issue.\n\nCloses #50\n\n" +
        `Explicitly invoke the installed issue-runner-handoff skill with this sole absolute output-path argument: ${JSON.stringify(saved.superseded[1])}`,
    ),
  );
  assert.equal(
    submissions[4]!.text,
    "Correct the implementation handoff: Execution findings_file must be null\n" +
      `Explicitly invoke issue-runner-handoff with the sole absolute output-path argument: ${JSON.stringify(saved.invocation!.path)}`,
  );
  assert.ok(
    submissions
      .slice(1)
      .every(
        ({ tab, chord }) =>
          tab === submissions[0]!.tab && chord === "Shift+Enter",
      ),
  );
  assert.deepEqual(
    fixture.state.sleeps.filter((ms) => ms !== 30_000),
    [10_000, 1_000, 2_000],
  );
}

export async function testPromptContinuation(
  t: TestContext,
  execute: typeof executeCli,
) {
  const fixture = await implementationRun(t);
  fixture.state.onTask = async () => {
    fixture.controller.abort();
  };
  assert.equal(
    (await execute(implementationCommand, fixture.dependencies)).summary
      .outcome,
    "cancelled",
  );
  const saved = await fixture.snapshot();
  const before = fixture.state.submissions.length;
  fixture.state.onSleep = async (ms) => {
    if (ms === 250) await publish(saved.invocation!.path, committed());
  };
  fixture.state.evidence.commits = committed().commits;
  assert.equal(
    (
      await execute(implementationCommand, {
        ...fixture.dependencies,
        signal: new AbortController().signal,
      })
    ).summary.outcome,
    "incomplete",
  );
  assert.deepEqual(
    fixture.state.submissions
      .slice(before)
      .map(({ text, chord }) => ({ text, chord })),
    [
      { text: 'any-cli --resume "native/$&/$`/$\'/session"', chord: "Enter" },
      { text: "continue", chord: "Shift+Enter" },
    ],
  );
  assert.deepEqual(
    fixture.state.sleeps.slice(1).filter((ms) => ms !== 30_000),
    [10_000, 250],
  );
}
