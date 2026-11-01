import assert from "node:assert/strict";
import test from "node:test";
import { ESLint } from "eslint";
import tseslint from "typescript-eslint";

// Virtual snippets exercise syntax rules without creating a TypeScript project.
const eslint = new ESLint({
  overrideConfig: [tseslint.configs.disableTypeChecked],
});

/** @param {string} source @param {string} filePath */
async function diagnostics(source, filePath) {
  const [result] = await eslint.lintText(source, { filePath });
  assert.ok(result);
  assert.equal(result.fatalErrorCount, 0);
  return result.messages.map((message) => message.ruleId);
}

await test("business modules reject platform and implementation coupling", async () => {
  const cases = [
    ['export { platform } from "node:os";', "no-restricted-imports"],
    ['export { exec } from "node:child_process";', "no-restricted-imports"],
    [
      'export { platform as host } from "node:process";',
      "no-restricted-imports",
    ],
    ['export { win32 } from "node:path/win32";', "no-restricted-imports"],
    [
      'export { client } from "../adapters/github.js";',
      "no-restricted-imports",
    ],
    ['export { client } from "@anthropic-ai/sdk";', "no-restricted-imports"],
    ['export { client } from "openai";', "no-restricted-imports"],
    ['export { plugin } from "issue-runner-herdr";', "no-restricted-imports"],
    ["export const host = process.platform;", "no-restricted-properties"],
    ['export const host = process["arch"];', "no-restricted-properties"],
    ["export const { platform: host } = process;", "no-restricted-properties"],
    [
      'export const plugin = import("issue-runner-herdr");',
      "no-restricted-syntax",
    ],
  ];
  for (const filePath of ["src/run/check.ts", "src/agent/check.ts"]) {
    for (const [source, rule] of cases) {
      assert.ok(source && rule);
      assert.ok((await diagnostics(source, filePath)).includes(rule), source);
    }
  }
});

await test("portable dependencies and adapter wiring remain allowed", async () => {
  for (const source of [
    'export { join } from "node:path";',
    'export { readFile } from "node:fs/promises";',
    'export { terminalContractVersion } from "issue-runner-core/terminal";',
  ]) {
    assert.deepEqual(await diagnostics(source, "src/run/check.ts"), []);
  }
  const source =
    'export { platform } from "node:os";\nexport const host = process.platform;';
  for (const filePath of ["src/adapters/check.ts", "src/cli.ts"]) {
    assert.deepEqual(await diagnostics(source, filePath), []);
  }
});
