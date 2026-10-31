import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { testGlobalPluginLoading } from "./package/terminal-plugin.mjs";

const root = fileURLToPath(new URL("../", import.meta.url));

await test("built artifacts work in isolated consumer and npm global installations", async (t) => {
  const consumer = mkdtempSync(join(tmpdir(), "issue-runner-contract "));
  t.after(() => rmSync(consumer, { recursive: true, force: true }));
  const npmCli = process.env.npm_execpath;
  assert.ok(npmCli, "Run this package test through npm test.");
  /** @param {string[]} args @param {string} cwd @param {NodeJS.ProcessEnv} [env] */
  const runNode = (args, cwd, env = process.env) =>
    execFileSync(process.execPath, args, {
      cwd,
      env,
      encoding: "utf8",
      timeout: 120_000,
    });
  /** @param {string[]} args @param {string} cwd */
  const npm = (args, cwd) => runNode([npmCli, ...args], cwd);

  /** @type {unknown} */
  const packed = JSON.parse(
    npm(["pack", "--json", "--pack-destination", consumer], root),
  );
  assert.ok(Array.isArray(packed));
  /** @type {unknown} */
  const artifact = packed[0];
  assert.ok(artifact && typeof artifact === "object");
  assert.ok("filename" in artifact && typeof artifact.filename === "string");
  assert.ok("files" in artifact && Array.isArray(artifact.files));
  const files = artifact.files.map(
    /** @param {unknown} file */
    (file) => {
      assert.ok(file && typeof file === "object" && "path" in file);
      assert.ok(typeof file.path === "string");
      return file.path;
    },
  );
  for (const file of [
    "dist/cli.js",
    "dist/terminal.js",
    "dist/terminal.d.ts",
    "dist/prompts/implement.js",
    "dist/prompts/documentation.js",
    "dist/prompts/review.js",
    "dist/agent/stage.js",
    "dist/run/review.js",
    "dist/run/documentation.js",
    "dist/run/execution-recovery.js",
    "templates/config.yaml",
    "templates/prompts/implement.md",
    "templates/prompts/review.md",
    "templates/prompts/documentation.md",
    "skills/issue-runner-handoff/SKILL.md",
  ])
    assert.ok(files.includes(file), file);
  assert.ok(files.every((file) => !file.startsWith("tests/")));

  writeFileSync(
    join(consumer, "package.json"),
    JSON.stringify({ private: true, type: "module" }),
  );
  npm(
    [
      "install",
      "--offline",
      "--ignore-scripts",
      "--no-audit",
      "--no-fund",
      "--package-lock=false",
      "--omit=dev",
      join(consumer, artifact.filename),
    ],
    consumer,
  );
  /** @type {unknown} */
  const manifest = JSON.parse(
    readFileSync(
      join(consumer, "node_modules/issue-runner-core/package.json"),
      "utf8",
    ),
  );
  assert.ok(manifest && typeof manifest === "object");
  assert.ok(
    "exports" in manifest &&
      manifest.exports &&
      typeof manifest.exports === "object",
  );
  assert.deepEqual(Object.keys(manifest.exports), ["./terminal"]);
  assert.ok("bin" in manifest);
  assert.deepEqual(manifest.bin, { "issue-runner": "dist/cli.js" });
  assert.ok("engines" in manifest);
  assert.deepEqual(manifest.engines, {
    node: ">=22.18.0 <23",
    npm: ">=11 <12",
  });

  const output = execFileSync(
    process.execPath,
    [
      "--input-type=module",
      "--eval",
      `import assert from "node:assert/strict";
       const contract = await import("issue-runner-core/terminal");
       assert.deepEqual(Object.keys(contract), ["terminalContractVersion"]);
       assert.equal(contract.terminalContractVersion, 1);
       await assert.rejects(import("issue-runner-core/terminal/testing"),
         { code: "ERR_PACKAGE_PATH_NOT_EXPORTED" });
       console.log("terminal contract v1");`,
    ],
    { cwd: consumer, encoding: "utf8", timeout: 30_000 },
  );
  assert.equal(output.trim(), "terminal contract v1");

  await testGlobalPluginLoading(t, {
    consumer,
    artifact: join(consumer, artifact.filename),
    npm,
    runNode,
  });
});
