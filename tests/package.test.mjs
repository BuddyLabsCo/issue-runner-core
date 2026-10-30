import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import {
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { pathToFileURL } from "node:url";
import { test } from "node:test";
import { stringify } from "yaml";
import { validConfig } from "./support/cli-project.ts";

const root = fileURLToPath(new URL("../", import.meta.url));
const require = createRequire(import.meta.url);

await test("a packed contract imports from an independent plugin directory", (t) => {
  const consumer = mkdtempSync(join(tmpdir(), "issue-runner-contract "));
  t.after(() => rmSync(consumer, { recursive: true, force: true }));
  const npmCli = process.env.npm_execpath;
  assert.ok(npmCli, "Run this package test through npm test.");
  /** @param {string[]} args @param {string} cwd */
  const runNode = (args, cwd) =>
    execFileSync(process.execPath, args, {
      cwd,
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

  copyFileSync(
    new URL("fixtures/terminal-consumer.mts", import.meta.url),
    join(consumer, "consumer.mts"),
  );
  execFileSync(
    process.execPath,
    [
      require.resolve("typescript/bin/tsc"),
      "--strict",
      "--target",
      "ES2022",
      "--module",
      "NodeNext",
      "--moduleResolution",
      "NodeNext",
      "--outDir",
      "output",
      "consumer.mts",
    ],
    { cwd: consumer, stdio: "inherit", timeout: 30_000 },
  );
  assert.equal(
    readFileSync(join(consumer, "output/consumer.mjs"), "utf8").trim(),
    "export {};",
  );

  const prefix = join(consumer, "global prefix");
  npm(
    [
      "install",
      "--global",
      "--prefix",
      prefix,
      "--offline",
      "--ignore-scripts",
      "--no-audit",
      "--no-fund",
      join(consumer, artifact.filename),
    ],
    consumer,
  );
  const globalRoot = npm(
    ["root", "--global", "--prefix", prefix],
    consumer,
  ).trim();
  const core = join(globalRoot, "issue-runner-core");
  const launch = join(consumer, "launch");
  mkdirSync(launch);
  /** @param {string[]} args */
  const cli = (args) => runNode([join(core, "dist/cli.js"), ...args], launch);
  /** @type {unknown} */
  const installedManifest = JSON.parse(
    readFileSync(join(core, "package.json"), "utf8"),
  );
  assert.ok(
    installedManifest &&
      typeof installedManifest === "object" &&
      "version" in installedManifest,
  );
  assert.equal(cli(["--version"]).trim(), installedManifest.version);
  assert.match(cli(["run", "--help"]), /--env/);
  assert.match(cli(["init", "--project", "demo"]), /Initialized Project/);
  assert.ok(
    readFileSync(join(launch, "demo/config.yaml"), "utf8").includes(
      "{sessionref}",
    ),
  );
  writeFileSync(
    join(launch, "demo/config.yaml"),
    stringify({ ...validConfig, targetBranch: "main" }),
  );
  /** @param {string} environment */
  const runInstalled = (environment) => {
    /** @type {unknown} */
    const result = JSON.parse(
      runNode(
        [
          "--input-type=module",
          "--eval",
          `
      const { executeCli } = await import(${JSON.stringify(pathToFileURL(join(core, "dist/cli.js")).href)});
      let reads = 0;
      const result = await executeCli(["run", "--project", "demo", "--env", ${JSON.stringify(environment)}, "--parent", "48"], {
        launchDirectory: process.cwd(), env: { TRACKER_TOKEN: "test", HOST_TOKEN: "test" },
        tracker: {
          async getParent() { reads++; return { number: 48, state: "open", stateReason: null }; },
          async listChildrenPage() { return { children: [], nextPage: null }; }
        },
        operator: { write() {}, async pause() { throw new Error("unexpected pause"); } }
      });
      console.log(JSON.stringify({ ...result, reads }));
    `,
        ],
        launch,
      ),
    );
    assert.ok(
      result &&
        typeof result === "object" &&
        "exitCode" in result &&
        "summary" in result &&
        "reads" in result,
    );
    const summary = result.summary;
    assert.ok(
      summary &&
        typeof summary === "object" &&
        "outcome" in summary &&
        "reasons" in summary &&
        Array.isArray(summary.reasons),
    );
    return {
      exitCode: result.exitCode,
      reads: result.reads,
      summary: { outcome: summary.outcome, reasons: summary.reasons },
    };
  };
  const plugin = join(globalRoot, "issue-runner-scripted");
  mkdirSync(plugin);
  writeFileSync(
    join(plugin, "package.json"),
    JSON.stringify({
      name: "issue-runner-scripted",
      type: "module",
      exports: { ".": { import: "./index.js" } },
    }),
  );
  writeFileSync(
    join(plugin, "index.js"),
    `
    export const contractVersion = 1;
    export async function createTerminalPlugin() {
      return {
        async createTab() { throw new Error("empty parent must not dispatch"); },
        async submitText() { throw new Error("empty parent must not submit"); },
        async closeTab() { throw new Error("empty parent must not close"); }
      };
    }
  `,
  );
  assert.equal(runInstalled("scripted").summary.outcome, "no_work");
  assert.equal(runInstalled("../scripted").exitCode, 1);
  const missing = runInstalled("missing");
  assert.equal(missing.exitCode, 1);
  assert.match(missing.summary.reasons.join(" "), /issue-runner-missing/);
  assert.equal(missing.reads, 0);
  for (const source of [
    "export const contractVersion = 2;",
    "export const contractVersion = 1;",
    "export const contractVersion = 1; export async function createTerminalPlugin() { throw new Error('initialization failed'); }",
    "export const contractVersion = 1; export async function createTerminalPlugin() { return {}; }",
    "throw new Error('module load failed');",
  ]) {
    writeFileSync(join(plugin, "index.js"), source);
    const invalid = runInstalled("scripted");
    assert.equal(invalid.exitCode, 1);
    assert.equal(invalid.reads, 0);
    assert.match(
      invalid.summary.reasons.join(" "),
      /issue-runner-scripted.*same npm environment/,
    );
  }
});
