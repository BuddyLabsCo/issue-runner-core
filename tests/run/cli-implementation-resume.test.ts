/* eslint-disable @typescript-eslint/require-await -- Scripted external boundaries. */
import assert from "node:assert/strict";
import test from "node:test";
import { executeCli } from "../../src/cli.ts";
import {
  committed,
  implementationCommand,
  implementationRun,
  publish,
} from "../support/implementation-run.ts";
import { validConfig } from "../support/cli-project.ts";

await test("a retained implementation resumes only its saved role with literal all-occurrence session substitution", async (t) => {
  const fixture = await implementationRun(t, {
    ...validConfig,
    agents: {
      ...validConfig.agents,
      implement: {
        ...validConfig.agents.implement,
        resume: 'any-cli --resume "{sessionref}" --same "{sessionref}"',
      },
    },
  });
  fixture.state.onTask = async () => {
    /* Leave the invocation unfinished. */
  };
  fixture.state.onSleep = async (ms) => {
    if (ms === 250) fixture.controller.abort();
  };
  assert.equal((await fixture.run()).summary.outcome, "cancelled");
  const saved = await fixture.snapshot();
  const controller = new AbortController();
  const before = fixture.state.submissions.length;
  fixture.state.onSleep = async (ms) => {
    if (ms === 250) await publish(saved.invocation!.path, committed());
  };
  fixture.state.evidence.commits = committed().commits;
  const result = await executeCli(implementationCommand, {
    ...fixture.dependencies,
    signal: controller.signal,
  });
  assert.equal(result.summary.outcome, "incomplete");
  const resumed = fixture.state.submissions.slice(before);
  assert.equal(
    resumed[0]?.text,
    'any-cli --resume "native/$&/$`/$\'/session" --same "native/$&/$`/$\'/session"',
  );
  assert.equal(resumed[0]?.chord, "Enter");
  assert.deepEqual(
    resumed.slice(1).map((submission) => submission.text),
    ["continue"],
  );
  assert.equal(fixture.state.probeCount, 1);
  assert.equal(fixture.state.taskCount, 1);
  assert.equal((await fixture.snapshot()).execution_id, saved.execution_id);
  assert.equal(
    (await fixture.snapshot()).invocation?.path,
    saved.invocation?.path,
  );
  assert.equal((await fixture.snapshot()).pr_body, saved.pr_body);
});

await test("a durably completed implementation is verified without dispatching another native stage", async (t) => {
  const fixture = await implementationRun(t);
  assert.equal((await fixture.run()).summary.outcome, "incomplete");
  const before = fixture.state.submissions.length;
  assert.equal((await fixture.run()).summary.outcome, "incomplete");
  assert.equal(fixture.state.submissions.length, before);
  assert.equal(fixture.state.taskCount, 1);
});
