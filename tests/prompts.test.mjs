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
    "ci-repair": "CI repair",
    "conflict-repair": "Conflict repair",
  })) {
    const template = loadPrompt(asset);
    assert.ok(template.startsWith(`${heading} assignment\n`), asset);
    assert.ok(template.includes("issue-runner-handoff"), asset);
    assert.ok(template.endsWith("{{path}}"), asset);
  }
});
