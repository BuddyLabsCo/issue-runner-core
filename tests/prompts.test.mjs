import assert from "node:assert/strict";
import test from "node:test";
import { loadPrompt, renderPrompt } from "../src/prompts/load.ts";

await test("template values are inserted literally in one pass", () => {
  const instructions = "Keep $& and {{path}} and Unicode: 你好";
  assert.equal(
    renderPrompt("{{instructions}}\nOutput: {{path}}\nAgain: {{path}}", {
      instructions,
      path: '"/tmp/output $&.json"',
    }),
    `${instructions}\nOutput: "/tmp/output $&.json"\nAgain: "/tmp/output $&.json"`,
  );
});

await test("missing template values fail before dispatch", () => {
  assert.throws(
    () => renderPrompt("Review round: {{round}}", {}),
    /Missing prompt value: round/u,
  );
});

await test("each task template includes its complete assignment and handoff", () => {
  for (const [asset, heading] of Object.entries({
    implement: "Implementation",
    documentation: "Documentation",
    review: "Review",
    "review-fix": "Fix",
    "no-change-review": "No-change review",
    "no-change-fix": "No-change fix",
    "ci-repair": "CI repair",
    "conflict-repair": "Conflict repair",
  })) {
    const template = loadPrompt(asset);
    assert.ok(template.startsWith(`${heading} assignment\n`), asset);
    assert.ok(template.includes("issue-runner-handoff"), asset);
    assert.ok(template.endsWith("{{path}}"), asset);
  }
});

await test("recovery continues unfinished work with completion or human-action reporting", () => {
  const file = "/worktree/unfinished $&.json";
  const prompt = renderPrompt(loadPrompt("recovery"), {
    name: "Review fix",
    path: JSON.stringify(file),
  });
  assert.match(prompt, /continue unfinished work/iu);
  assert.ok(
    prompt.includes(
      "Use the issue-runner-handoff skill to report task completion or a pause requiring user action.",
    ),
  );
  assert.doesNotMatch(
    prompt,
    /\[action required\]|Do not create the handoff file/u,
  );
  assert.ok(prompt.endsWith(JSON.stringify(file)));
});

await test("Probe recovery continues the identity exchange through its exact assigned protocol", () => {
  const file = '/worktree/Probe "quoted" $&.json';
  const prompt = renderPrompt(loadPrompt("probe-recovery"), {
    temporary: JSON.stringify(`${file}.tmp`),
    path: JSON.stringify(file),
  });
  assert.match(prompt, /continue the unfinished Session Probe/iu);
  assert.match(prompt, /actual native conversation session ID/u);
  assert.match(prompt, /assigned Probe protocol/u);
  assert.ok(prompt.includes(JSON.stringify(`${file}.tmp`)));
  assert.ok(prompt.includes(JSON.stringify(file)));
  assert.match(prompt, /atomically rename/u);
  assert.match(
    prompt,
    /Do not begin or replay the business task, or report business completion/u,
  );
  assert.doesNotMatch(prompt, /issue-runner-handoff|\{\{\w+\}\}/u);
});
