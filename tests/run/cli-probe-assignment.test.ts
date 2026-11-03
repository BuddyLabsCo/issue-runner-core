/* eslint-disable @typescript-eslint/require-await -- Scripted external boundaries. */
import assert from "node:assert/strict";
import path from "node:path";
import test, { type TestContext } from "node:test";
import type { TerminalPlugin } from "../../src/terminal.ts";
import { loadPrompt, renderPrompt } from "../../src/prompts/load.ts";
import { ciRepairRun } from "../support/ci-repair-run.ts";
import { conflictRepairRun } from "../support/conflict-repair-run.ts";
import { documentationRun } from "../support/documentation-run.ts";
import { implementationRun, publish } from "../support/implementation-run.ts";
import { promptAssignment } from "../support/prompt-assignment.ts";
import { findings, reviewRun } from "../support/review-run.ts";

for (const [purpose, create] of [
  ["implement", implementationRun],
  ["documentation", documentationRun],
  [
    "review",
    async (t: TestContext) => {
      const fixture = await reviewRun(t, 1);
      fixture.reviewState.onReview = findings;
      return fixture;
    },
  ],
  ["ci_repair", ciRepairRun],
  ["conflict_repair", conflictRepairRun],
] as const) {
  await test(`${purpose} Probe and correction forward the persisted assignment through every terminal wrapper`, async (t) => {
    const fixture = await create(t);
    const plugin: TerminalPlugin = fixture.dependencies.terminalPlugin;
    const open = plugin.createTab.bind(plugin);
    let currentTab: object;
    plugin.createTab = async (options) => (currentTab = await open(options));
    const submit = plugin.submitText.bind(plugin);
    const paths = new Map<string, string[]>();
    plugin.submitText = async (...args) => {
      const [, text] = args;
      if (!text.startsWith("Session Probe\n")) return submit(...args);
      const assignment = promptAssignment(text);
      const saved = await fixture.snapshot();
      const stage =
        assignment.role === "review"
          ? saved.reviews!.at(-1)!
          : assignment.role === "ciRepair" ||
              assignment.role === "conflictRepair"
            ? saved.publication![assignment.role]!.attempts.at(-1)!
            : saved;
      const file = stage.probe!.path;
      const role = String(assignment.role);
      const assigned = paths.get(role) ?? [];
      assert.equal(assignment.path, file);
      assert.ok(path.isAbsolute(file));
      assert.deepEqual(args, [
        currentTab!,
        renderPrompt(loadPrompt("probe"), {
          correction: assigned.length
            ? renderPrompt(loadPrompt("probe-correction"), {
                reason: "Probe requires actual native identity",
              })
            : "",
          issue: "50",
          temporary: JSON.stringify(`${file}.tmp`),
          path: JSON.stringify(file),
        }),
        "Shift+Enter",
        file,
        `Continue the unfinished Session Probe in this conversation. Determine your actual native conversation session ID and report it through the assigned Probe protocol.\n\nWrite the JSON object to ${JSON.stringify(`${file}.tmp`)}, close it, and atomically rename it to ${JSON.stringify(file)}. Do not begin or replay the business task, or report business completion.`,
      ] satisfies Parameters<TerminalPlugin["submitText"]>);
      if (assigned.length) {
        assert.notEqual(file, assigned[0]);
        assert.ok(stage.superseded.includes(assigned[0]!));
        assert.ok(text.includes("Correct the previous Probe:"));
        assert.ok(!args[4].includes(assigned[0]!));
      }
      assigned.push(file);
      paths.set(role, assigned);
      await submit(...args);
      if (assigned.length === 1) await publish(file, { sessionid: "latest" });
    };
    const result = await fixture.run();
    assert.ok(
      ["incomplete", "succeeded"].includes(result.summary.outcome),
      JSON.stringify(result),
    );
    const role =
      purpose === "ci_repair"
        ? "ciRepair"
        : purpose === "conflict_repair"
          ? "conflictRepair"
          : purpose;
    assert.equal(paths.get(role)?.length, 2);
    if (purpose === "review")
      assert.ok(
        fixture.state.submissions.some(({ text }) =>
          text.startsWith("Fix assignment\n"),
        ),
      );
  });
}

await test("restored documentation uses the current corrected Probe instead of superseded identity", async (t) => {
  const fixture = await documentationRun(t);
  fixture.state.onProbe = async (assignment) => {
    await publish(String(assignment.path), {
      sessionid: fixture.state.probeCount === 1 ? "latest" : "current-native",
    });
    if (fixture.state.probeCount === 2) fixture.controller.abort();
  };
  assert.equal((await fixture.run()).summary.outcome, "cancelled");
  const before = await fixture.snapshot();
  assert.equal(before.roles.documentation, undefined);
  assert.equal(before.superseded.length, 1);
  assert.notEqual(before.probe!.path, before.superseded[0]);
  await publish(before.superseded[0]!, { sessionid: "superseded-native" });
  fixture.state.onProbe = async () =>
    assert.fail("retained Probe needs no replay");
  fixture.dependencies.terminalPlugin.start = async () =>
    assert.fail("restored identity must resume its native conversation");
  const refs: string[] = [];
  fixture.dependencies.terminalPlugin.resume = async (_tab, command, ref) => {
    refs.push(ref);
    assert.equal(command, 'document-cli --resume "current-native"');
    return ref;
  };
  fixture.dependencies.signal = new AbortController().signal;
  assert.equal((await fixture.run()).summary.outcome, "succeeded");
  assert.deepEqual(refs, ["current-native"]);
  const after = await fixture.snapshot();
  assert.deepEqual(after.probe, before.probe);
  assert.deepEqual(after.superseded, before.superseded);
  assert.equal(after.roles.documentation?.sessionid, "current-native");
});
