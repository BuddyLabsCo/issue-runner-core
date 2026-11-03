import assert from "node:assert/strict";
import test from "node:test";
import { parseExecution, parsePRExecution } from "../../src/agent/handoff.ts";
import { execution as committed } from "../support/implementation-run.ts";

await test("PR-producing handoffs require metadata while repair handoffs keep their schema", () => {
  const execution = committed();
  const result = {
    ...execution,
    pr_title: "feat: deliver",
    pr_body: "Closes #50",
  };
  assert.deepEqual(parsePRExecution(JSON.stringify(result)), result);
  assert.deepEqual(parseExecution(JSON.stringify(execution)), execution);
  assert.throws(
    () => parsePRExecution(JSON.stringify(execution)),
    /requires exactly/,
  );
  assert.throws(
    () => parseExecution(JSON.stringify(result)),
    /requires exactly/,
  );
});

for (const outcome of ["committed", "no_change"]) {
  const result = {
    ...committed(),
    outcome,
    commits: outcome === "committed" ? committed().commits : [],
    pr_title: "docs: update guide",
    pr_body: "Updated guide. Closes #50",
  };
  await test(`PR-producing handoffs accept ${outcome}`, () => {
    assert.deepEqual(parsePRExecution(JSON.stringify(result)), result);
  });
  for (const field of ["pr_title", "pr_body"]) {
    for (const invalid of [undefined, null, "", " \n ", 42]) {
      await test(`${outcome} rejects ${field}=${String(invalid)}`, () => {
        assert.throws(
          () =>
            parsePRExecution(JSON.stringify({ ...result, [field]: invalid })),
          /requires exactly|nonempty/,
        );
      });
    }
  }
}

await test("PR metadata does not bypass execution evidence validation or admit extra fields", () => {
  const result = { ...committed(), pr_title: "Title", pr_body: "Body" };
  assert.throws(
    () => parsePRExecution(JSON.stringify({ ...result, commits: [] })),
    /committed requires commits/,
  );
  assert.throws(
    () => parsePRExecution(JSON.stringify({ ...result, extra: true })),
    /requires exactly/,
  );
});
