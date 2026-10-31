import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

await test("explicit handoff skill defines the result and ends all work at publication", () => {
  const content = readFileSync(
    new URL("../skills/issue-runner-handoff/SKILL.md", import.meta.url),
    "utf8",
  );
  assert.match(content, /disable-model-invocation: true/u);
  assert.match(
    content,
    /Invoke this skill only after completing all task work, checks, and local commits/u,
  );
  const block = /```json\s*([\s\S]*?)```/u.exec(content);
  assert.ok(block?.[1]);
  /** @type {unknown} */
  const example = JSON.parse(block[1]);
  assert.ok(example && typeof example === "object");
  assert.deepEqual(Object.keys(example).sort(), [
    "commits",
    "findings_file",
    "outcome",
    "summary",
  ]);
  assert.match(content, /Report only work and checks actually performed/u);
  assert.match(
    content,
    /atomically rename the temporary file to the final path/u,
  );
  assert.match(
    content,
    /After publishing the final file, stop\. Do not modify files, create commits, or perform further task work/u,
  );
});
