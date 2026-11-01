import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";
import { parseExecution, parseReview } from "../../src/agent/handoff.ts";
import { committed } from "../support/implementation-run.ts";

for (const [name, output, reason] of [
  ["invalid JSON", "{", /JSON|Unexpected/u],
  ["non-object JSON", "[]", /Expected a JSON object/u],
  ["missing fields", "{}", /requires exactly/u],
  [
    "legacy fields",
    JSON.stringify({ ...committed(), checks: [] }),
    /requires exactly/u,
  ],
  [
    "Review outcome",
    JSON.stringify({ ...committed(), outcome: "findings" }),
    /Invalid implementation outcome/u,
  ],
  [
    "empty summary",
    JSON.stringify({ ...committed(), summary: " " }),
    /Execution summary must be a nonempty string/u,
  ],
  [
    "non-array commits",
    JSON.stringify({ ...committed(), commits: null }),
    /Execution commits must be an array/u,
  ],
  [
    "invalid commit",
    JSON.stringify({
      ...committed(),
      commits: [{ sha: "abc", message: "Partial SHA" }],
    }),
    /Invalid full-SHA\/message commit evidence/u,
  ],
  [
    "missing committed evidence",
    JSON.stringify({ ...committed(), commits: [] }),
    /committed requires commits/u,
  ],
  [
    "duplicate commits",
    JSON.stringify({
      ...committed(),
      commits: [...committed().commits, ...committed().commits],
    }),
    /Duplicate claimed commits/u,
  ],
] as const) {
  await test(`execution handoff rejects ${name}`, () => {
    assert.throws(() => parseExecution(output), reason);
  });
}

await test("execution handoffs accept committed and no_change results", () => {
  assert.deepEqual(parseExecution(JSON.stringify(committed())), committed());
  const noChange = { ...committed(), outcome: "no_change", commits: [] };
  assert.deepEqual(parseExecution(JSON.stringify(noChange)), noChange);
});

const findings = path.resolve("assigned-findings.md");
const passed = {
  outcome: "passed",
  summary: "Reviewed",
  commits: [],
  findings_file: null,
};
for (const [name, patch, reason] of [
  ["wrong purpose", { outcome: "committed" }, /Invalid Review outcome/u],
  ["extra field", { checks: [] }, /requires exactly/u],
  ["empty summary", { summary: " " }, /nonempty summary/u],
  ["claimed commits", { commits: committed().commits }, /no commits/u],
  ["passed findings", { findings_file: findings }, /must be null/u],
  [
    "wrong findings path",
    { outcome: "findings", findings_file: `${findings}-unassigned` },
    /assigned absolute path/u,
  ],
  [
    "relative findings path",
    { outcome: "findings", findings_file: path.basename(findings) },
    /assigned absolute path/u,
  ],
] as const) {
  await test(`Review handoff rejects ${name}`, () => {
    assert.throws(
      () => parseReview(JSON.stringify({ ...passed, ...patch }), findings),
      reason,
    );
  });
}

await test("Review handoffs accept passed and assigned findings results", () => {
  assert.deepEqual(parseReview(JSON.stringify(passed), findings), passed);
  const result = { ...passed, outcome: "findings", findings_file: findings };
  assert.deepEqual(parseReview(JSON.stringify(result), findings), result);
});
