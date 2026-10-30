import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { copyFileSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

const root = fileURLToPath(new URL("../", import.meta.url));
const require = createRequire(import.meta.url);

test("a packed contract imports from an independent plugin directory", (t) => {
  const consumer = mkdtempSync(join(tmpdir(), "issue-runner-contract "));
  t.after(() => rmSync(consumer, { recursive: true, force: true }));
  const npm = (args, cwd) =>
    execFileSync(process.execPath, [process.env.npm_execpath, ...args], {
      cwd,
      encoding: "utf8",
      timeout: 120_000,
    });

  const [artifact] = JSON.parse(
    npm(["pack", "--json", "--pack-destination", consumer], root),
  );
  assert.deepEqual(
    artifact.files.map(({ path }) => path).sort(),
    [
      "README.md",
      "dist/terminal.d.ts",
      "dist/terminal.js",
      "docs/terminal-contract.md",
      "package.json",
    ],
  );

  writeFileSync(
    join(consumer, "package.json"),
    JSON.stringify({ private: true, type: "module" }),
  );
  npm(
    [
      "install", "--offline", "--ignore-scripts", "--no-audit", "--no-fund",
      "--package-lock=false", "--omit=dev", join(consumer, artifact.filename),
    ],
    consumer,
  );
  const manifest = JSON.parse(
    readFileSync(join(consumer, "node_modules/issue-runner-core/package.json"), "utf8"),
  );
  assert.deepEqual(Object.keys(manifest.exports), ["./terminal"]);
  assert.equal(manifest.bin, undefined);
  assert.equal(manifest.dependencies, undefined);
  assert.deepEqual(manifest.engines, { node: ">=22.18.0 <23", npm: ">=11 <12" });

  const output = execFileSync(
    process.execPath,
    [
      "--input-type=module", "--eval",
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

  copyFileSync(
    new URL("fixtures/terminal-consumer.mts", import.meta.url),
    join(consumer, "consumer.mts"),
  );
  execFileSync(
    process.execPath,
    [
      require.resolve("typescript/bin/tsc"), "--strict", "--target", "ES2022",
      "--module", "NodeNext", "--moduleResolution", "NodeNext",
      "--outDir", "output", "consumer.mts",
    ],
    { cwd: consumer, stdio: "inherit", timeout: 30_000 },
  );
  assert.equal(
    readFileSync(join(consumer, "output/consumer.mjs"), "utf8").trim(),
    "export {};",
  );
});
