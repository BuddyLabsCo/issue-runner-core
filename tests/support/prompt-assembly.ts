/* eslint-disable @typescript-eslint/require-await -- Scripted external boundaries. */
import assert from "node:assert/strict";
import { writeFile } from "node:fs/promises";
import path from "node:path";
import type { TestContext } from "node:test";
import type { executeCli } from "../../src/cli.ts";
import { loadPrompt, renderPrompt } from "../../src/prompts/load.ts";
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
  fixture.state.ticket.body = "Issue content must be read from the tracker";
  const custom =
    "Project implement instructions\nKeep literal $& and {{path}} and Unicode: 你好";
  await writeFile(
    path.join(fixture.directory, "prompts", "implement.md"),
    custom,
  );
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
      renderPrompt(loadPrompt("probe"), {
        issue: "50",
        correction:
          index === 1
            ? renderPrompt(loadPrompt("probe-correction"), {
                reason: "Probe requires actual native identity only",
              })
            : "",
        temporary: JSON.stringify(`${String(assignment.path)}.tmp`),
        path: JSON.stringify(assignment.path),
      }),
    );
  }
  const task = submissions[3]!.text;
  assert.ok(task.includes(custom));
  assert.match(task, /Do not fetch or pull code/u);
  assert.doesNotMatch(
    task,
    /execution_id|invocation_id|Fixed PR|Repository:|Worktree:|Delivery branch:|Base SHA:|Target Branch:|Its four fields|Issue #50:|Accepted scope/u,
  );
  assert.ok(!task.includes(fixture.state.ticket.body));
  for (const { text } of submissions.slice(1, 3))
    assert.doesNotMatch(
      text,
      /probe_id|run_id|execution_id|owner\/repo|Implement the Issue|Accepted scope/u,
    );
  const saved = await fixture.snapshot();
  assert.equal(
    task,
    renderPrompt(loadPrompt("implement"), {
      issue: "50",
      instructions: custom,
      path: JSON.stringify(saved.superseded[1]),
    }),
  );
  assert.ok(
    task.endsWith(
      `Once the task is complete, explicitly invoke the installed issue-runner-handoff skill as your final action, with this sole absolute output-path argument: ${JSON.stringify(saved.superseded[1])}`,
    ),
  );
  assert.equal(
    submissions[4]!.text,
    "Correct the implementation handoff: Execution findings_file must be null\n\n" +
      `After completing the correction, explicitly invoke the installed issue-runner-handoff skill as your final action, with this sole absolute output-path argument: ${JSON.stringify(saved.invocation!.path)}`,
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
    [],
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
    fixture.state.sleeps.filter((ms) => ms !== 30_000),
    [250],
  );
}
