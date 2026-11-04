import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { testTerminalCommand } from "./package/terminal-plugin.mjs";

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

  const artifactsDir = join(consumer, "artifacts");
  mkdirSync(artifactsDir);
  npm(["pack", "--pack-destination", artifactsDir], root);
  const tarballs = readdirSync(artifactsDir).filter((file) =>
    file.endsWith(".tgz"),
  );
  assert.equal(tarballs.length, 1);
  assert.ok(tarballs[0]);
  const artifact = join(artifactsDir, tarballs[0]);

  writeFileSync(
    join(consumer, "package.json"),
    JSON.stringify({ private: true, type: "module" }),
  );
  npm(
    [
      "install",
      "--ignore-scripts",
      "--no-audit",
      "--no-fund",
      "--package-lock=false",
      "--omit=dev",
      artifact,
    ],
    consumer,
  );
  const installed = join(consumer, "node_modules/issue-runner-core");
  for (const file of [
    "dist/cli.js",
    "dist/cli-entry.js",
    "dist/cli-entry.d.ts",
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
    "prompts/implement.md",
    "prompts/review.md",
    "prompts/review-fix.md",
    "prompts/documentation.md",
    "prompts/ci-repair.md",
    "prompts/conflict-repair.md",
    "prompts/probe.md",
    "prompts/probe-correction.md",
    "prompts/probe-recovery.md",
    "prompts/resume.md",
    "prompts/recovery.md",
    "prompts/handoff-correction.md",
  ])
    assert.ok(statSync(join(installed, file)).isFile(), file);
  assert.ok(!readdirSync(installed).includes("tests"));

  /** @type {unknown} */
  const manifest = JSON.parse(
    readFileSync(join(installed, "package.json"), "utf8"),
  );
  assert.ok(manifest && typeof manifest === "object");
  assert.ok(
    "exports" in manifest &&
      manifest.exports &&
      typeof manifest.exports === "object",
  );
  assert.deepEqual(Object.keys(manifest.exports), ["./terminal", "./cli"]);
  assert.ok(!("bin" in manifest));
  assert.ok("engines" in manifest);
  assert.deepEqual(manifest.engines, {
    node: ">=22.18.0",
    npm: ">=11",
  });

  const output = execFileSync(
    process.execPath,
    [
      "--input-type=module",
      "--eval",
      `import assert from "node:assert/strict";
       const contract = await import("issue-runner-core/terminal");
       assert.deepEqual(Object.keys(contract), ["enhancementContractVersion", "terminalContractVersion"]);
       assert.equal(contract.terminalContractVersion, 2);
       assert.equal(contract.enhancementContractVersion, 2);
       await assert.rejects(import("issue-runner-core/terminal/testing"),
         { code: "ERR_PACKAGE_PATH_NOT_EXPORTED" });
       const before = [process.listenerCount("SIGINT"), process.listenerCount("SIGTERM")];
       const cli = await import("issue-runner-core/cli");
       assert.deepEqual(Object.keys(cli), ["runCli"]);
       assert.deepEqual([process.listenerCount("SIGINT"), process.listenerCount("SIGTERM")], before);
       assert.equal(process.exitCode, undefined);
       await assert.rejects(import("issue-runner-core/cli/testing"), { code: "ERR_PACKAGE_PATH_NOT_EXPORTED" });
       console.log("terminal contract v2");`,
    ],
    { cwd: consumer, encoding: "utf8", timeout: 30_000 },
  );
  assert.equal(output.trim(), "terminal contract v2");

  await testTerminalCommand(t, {
    consumer,
    artifact,
    npm,
    runNode,
  });
});
