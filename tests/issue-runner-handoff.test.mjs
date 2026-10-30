import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import test from "node:test";

await test("repository ships the exact accepted explicit handoff skill", () => {
  const content = readFileSync(
    new URL("../skills/issue-runner-handoff/SKILL.md", import.meta.url),
    "utf8",
  ).replace(/\r\n/g, "\n");

  // SHA-256 of the accepted Markdown block, with LF and a final newline:
  // https://github.com/BuddyLabsCo/issue-runner-core/issues/5#issuecomment-6497094791
  assert.equal(
    createHash("sha256").update(content).digest("hex"),
    "77f5c0ee933f63439046d36f1ed1d995d296fb96881eff5af6d4b4e4ade52fbe",
    "The skill must match the accepted content, including its invocation and handoff protocol.",
  );
});
