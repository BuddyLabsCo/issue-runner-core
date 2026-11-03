import test from "node:test";
import { executeCli } from "../../src/cli.ts";
import assert from "node:assert/strict";
import path from "node:path";
import { loadPrompt, renderPrompt } from "../../src/prompts/load.ts";
import {
  testPromptAssembly,
  testPromptContinuation,
} from "../support/prompt-assembly.ts";

await test("prompt assembly preserves literal context, separate submissions and waits", (t) =>
  testPromptAssembly(t, executeCli));

await test("retained prompt assignments resume with only continue after startup", (t) =>
  testPromptContinuation(t, executeCli));

for (const name of [
  "implement",
  "documentation",
  "review",
  "review-fix",
  "ci-repair",
  "conflict-repair",
  "handoff-correction",
  "recovery",
]) {
  await test(`${name} prompt explicitly requests completion or human-action reporting`, () => {
    const handoff = path.resolve('handoffs/task "quoted" 你好.json');
    const prompt = renderPrompt(loadPrompt(name), {
      issue: "210",
      instructions: "Project instructions",
      round: "1",
      base: "base-sha",
      head: "head-sha",
      findings: "findings.md",
      pr: "https://example.com/pull/1",
      checks: "Failed check",
      target_base: "target-sha",
      conflict: "Merge conflict",
      name: "implementation",
      reason: "Invalid handoff",
      path: JSON.stringify(handoff),
    });
    const instruction =
      "Use the issue-runner-handoff skill to report task completion or a pause requiring user action.";
    assert.ok(
      prompt.endsWith(
        `${instruction}\nHandoff path: ${JSON.stringify(handoff)}`,
      ),
    );
    assert.equal(prompt.split(instruction).length, 2);
    assert.doesNotMatch(
      prompt,
      /\{\{\w+\}\}|\[action required\]|Do not create the handoff file|sole absolute output-path argument/u,
    );
  });
}
