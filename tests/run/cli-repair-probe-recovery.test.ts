/* eslint-disable @typescript-eslint/require-await -- Scripted external boundaries. */
import assert from "node:assert/strict";
import { access, mkdir, rm, writeFile } from "node:fs/promises";
import test from "node:test";
import { ciRepairRun } from "../support/ci-repair-run.ts";
import { conflictRepairRun } from "../support/conflict-repair-run.ts";

for (const kind of ["ci", "conflict"] as const) {
  await test(`interrupted ${kind} repair Probe restores retained native identity before dispatch`, async (t) => {
    const fixture = await (kind === "ci" ? ciRepairRun : conflictRepairRun)(t);
    const submit = fixture.dependencies.terminalPlugin.submitText.bind(
      fixture.dependencies.terminalPlugin,
    );
    fixture.dependencies.terminalPlugin.submitText = async (
      tab,
      text,
      chord,
    ) => {
      await submit(tab, text, chord);
      if (text.startsWith("Session Probe\n") && text.includes(`${kind}Repair`))
        fixture.controller.abort();
    };
    assert.equal((await fixture.run()).summary.outcome, "cancelled");
    const before = await fixture.snapshot();
    const key = kind === "ci" ? "ciRepair" : "conflictRepair";
    const pending = before.publication![key]!.attempts[0]!;
    assert.ok(pending.probe);
    assert.equal(pending.sessionid, undefined);
    fixture.dependencies.signal = new AbortController().signal;
    fixture.dependencies.terminalPlugin.submitText = submit;
    const submissions = fixture.state.submissions.length;
    const result = await fixture.run();
    assert.match(result.summary.reasons.join(" "), /CI-ready|completed/u);
    const after = await fixture.snapshot();
    const restored = after.publication![key]!.attempts[0]!;
    assert.equal(restored.attempt_id, pending.attempt_id);
    assert.deepEqual(restored.probe, pending.probe);
    assert.equal(restored.sessionid, `${kind}-session-1`);
    assert.equal(after.publication![key]!.consumed, 1);
    assert.equal(fixture.repairs.probes.length, 1);
    assert.equal(fixture.repairs.tasks.length, 1);
    assert.ok(
      fixture.state.submissions
        .slice(submissions)
        .some(({ text }) => text.includes(`--resume "${kind}-session-1"`)),
    );
    assert.equal(after.pr_title, before.pr_title);
    assert.equal(after.pr_body, before.pr_body);
    assert.equal(fixture.publicationState.creations, 1);
  });

  for (const probe of ["missing", "invalid", "directory"] as const) {
    await test(`${probe} interrupted ${kind} repair identity offers whole-Issue restart or exit`, async (t) => {
      const fixture = await (kind === "ci" ? ciRepairRun : conflictRepairRun)(
        t,
      );
      const submit = fixture.dependencies.terminalPlugin.submitText.bind(
        fixture.dependencies.terminalPlugin,
      );
      fixture.dependencies.terminalPlugin.submitText = async (
        tab,
        text,
        chord,
      ) => {
        await submit(tab, text, chord);
        if (
          text.startsWith("Session Probe\n") &&
          text.includes(`${kind}Repair`)
        )
          fixture.controller.abort();
      };
      assert.equal((await fixture.run()).summary.outcome, "cancelled");
      const before = await fixture.snapshot();
      const key = kind === "ci" ? "ciRepair" : "conflictRepair";
      const pending = before.publication![key]!.attempts[0]!;
      if (probe === "missing") await rm(pending.probe!.path);
      else if (probe === "directory") {
        await rm(pending.probe!.path);
        await mkdir(pending.probe!.path);
      } else await writeFile(pending.probe!.path, "{}");
      fixture.dependencies.signal = new AbortController().signal;
      fixture.dependencies.terminalPlugin.submitText = submit;
      fixture.dependencies.operator.pause = async (message) => {
        assert.equal(
          message,
          "Enter to restart the entire Issue #50, or q to exit Runner.",
        );
        return "q";
      };
      const submissions = fixture.state.submissions.length;
      const result = await fixture.run();
      assert.equal(result.summary.outcome, "cancelled");
      assert.ok(fixture.dependencies.messages.includes("unable to recover"));
      assert.equal(fixture.state.submissions.length, submissions);
      assert.equal(fixture.repairs.tasks.length, 0);
      assert.equal(fixture.publicationState.pushes, 1);
      await access(pending.worktree);
      await access(before.worktree);
      await access(before.probe!.path);
      if (probe === "directory")
        assert.deepEqual(await fixture.snapshot(), before);
    });
  }
}
