import assert from "node:assert/strict";
import {
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { basename, delimiter, join, relative } from "node:path";
import { pathToFileURL } from "node:url";
import { stringify } from "yaml";
import { validConfig } from "../support/cli-project.ts";
import { testInstalledArtifacts } from "./installed-artifacts.mjs";

/**
 * @param {import("node:test").TestContext} t
 * @param {{ consumer: string, artifact: string,
 *   npm: (args: string[], cwd: string) => string,
 *   runNode: (args: string[], cwd: string, env?: NodeJS.ProcessEnv) => string }} options
 */
export async function testGlobalPluginLoading(
  t,
  { consumer, artifact, npm, runNode },
) {
  const prefix = join(consumer, "global prefix");
  const globalRoot = npm(
    ["root", "--global", "--prefix", prefix],
    consumer,
  ).trim();
  let core = join(globalRoot, "issue-runner-core");
  const launch = join(consumer, "launch");
  mkdirSync(launch);
  /** @param {string} environment @param {NodeJS.ProcessEnv} [env] */
  const runInstalled = (environment, env = process.env) => {
    /** @type {unknown} */
    const result = JSON.parse(
      runNode(
        [
          "--input-type=module",
          "--eval",
          `
      const { executeCli } = await import(${JSON.stringify(pathToFileURL(join(core, "dist/cli.js")).href)});
      let reads = 0;
      const effects = [];
      const result = await executeCli(["run", "--project", "demo", ${JSON.stringify(`--env=${environment}`)}, "--parent", "48"], {
        launchDirectory: process.cwd(), env: { TRACKER_TOKEN: "test", HOST_TOKEN: "test" },
        tracker: {
          async getParent() { reads++; return { number: 48, state: "open", stateReason: null }; },
          async listChildrenPage() { reads++; return { children: [], nextPage: null }; },
          async addLabel() { effects.push("reservation"); },
          async closeParent() { effects.push("close_parent"); }
        },
        codeHost: { async resolveTargetBranch() { reads++; return "main"; } },
        gitWorkspace: {
          async fetchTargetBranch() { effects.push("fetch"); },
          async createWorktree() { effects.push("worktree"); }
        },
        operator: { write() {}, async pause() { throw new Error("unexpected pause"); } }
      });
      console.log(JSON.stringify({ ...result, reads, effects }));
    `,
        ],
        launch,
        env,
      ),
    );
    assert.ok(
      result &&
        typeof result === "object" &&
        "exitCode" in result &&
        "summary" in result &&
        "reads" in result &&
        "effects" in result &&
        "logPath" in result,
    );
    const summary = result.summary;
    assert.ok(
      summary &&
        typeof summary === "object" &&
        "outcome" in summary &&
        "reasons" in summary &&
        Array.isArray(summary.reasons),
    );
    assert.deepEqual(result.effects, []);
    if (result.exitCode !== 0) {
      assert.equal(result.reads, 0, "startup must precede workflow reads");
      assert.equal(result.logPath, null, "startup must precede audit creation");
    }
    return {
      exitCode: result.exitCode,
      reads: result.reads,
      summary: { outcome: summary.outcome, reasons: summary.reasons },
    };
  };
  const events = join(consumer, "plugin-events");
  const validPlugin = `
    import assert from "node:assert/strict";
    import { appendFileSync } from "node:fs";
    import { terminalContractVersion } from "issue-runner-core/terminal";
    assert.equal(terminalContractVersion, 1);
    appendFileSync(${JSON.stringify(events)}, "module\\n");
    export const contractVersion = 1;
    export async function createTerminalPlugin() {
      if (arguments.length) throw new Error("factory must receive no arguments");
      await Promise.resolve();
      appendFileSync(${JSON.stringify(events)}, "initialized\\n");
      return {
        async createTab() { throw new Error("empty parent must not dispatch"); },
        async submitText() { throw new Error("empty parent must not submit"); },
        async closeTab() { throw new Error("empty parent must not close"); }
      };
    }
  `;
  /** @param {string} directory @param {string} [source] */
  const writePlugin = (directory, source = validPlugin) => {
    mkdirSync(directory, { recursive: true });
    writeFileSync(
      join(directory, "package.json"),
      JSON.stringify({
        name: basename(directory),
        version: "1.0.0",
        private: true,
        type: "module",
        main: "./private.js",
        exports: { ".": { import: "./index.js", require: "./private.js" } },
      }),
    );
    writeFileSync(join(directory, "index.js"), source);
    writeFileSync(
      join(directory, "private.js"),
      'throw new Error("must use the public import entry");',
    );
  };
  const plugin = join(globalRoot, "issue-runner-scripted");
  const pluginSource = join(
    consumer,
    "private plugin",
    "issue-runner-scripted",
  );
  writePlugin(pluginSource);
  /** @type {unknown} */
  const packed = JSON.parse(
    npm(
      ["pack", "--json", "--ignore-scripts", "--pack-destination", consumer],
      pluginSource,
    ),
  );
  assert.ok(Array.isArray(packed));
  assert.equal(packed.length, 1);
  /** @type {unknown} */
  const pluginArtifact = packed[0];
  assert.ok(pluginArtifact && typeof pluginArtifact === "object");
  assert.ok(
    "filename" in pluginArtifact && typeof pluginArtifact.filename === "string",
  );
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
      artifact,
      join(consumer, pluginArtifact.filename),
    ],
    launch,
  );
  /** @type {unknown} */
  const installedManifest = JSON.parse(
    readFileSync(join(core, "package.json"), "utf8"),
  );
  assert.ok(installedManifest && typeof installedManifest === "object");
  assert.ok(
    "version" in installedManifest &&
      typeof installedManifest.version === "string",
  );
  await testInstalledArtifacts(t, {
    core,
    plugin,
    prefix,
    launch,
    version: installedManifest.version,
    runNode,
  });
  writeFileSync(
    join(launch, "demo/config.yaml"),
    stringify({ ...validConfig, targetBranch: "main" }),
  );
  await t.test(
    "Core and a private plugin tarball share the custom global prefix",
    () => {
      /** @type {unknown} */
      const manifest = JSON.parse(
        readFileSync(join(plugin, "package.json"), "utf8"),
      );
      assert.ok(manifest && typeof manifest === "object");
      assert.ok("private" in manifest && manifest.private === true);
      assert.ok("version" in manifest && manifest.version === "1.0.0");
      /** @type {unknown} */
      const installed = JSON.parse(
        npm(
          ["ls", "--global", "--prefix", prefix, "--depth=0", "--json"],
          launch,
        ),
      );
      assert.ok(installed && typeof installed === "object");
      assert.ok(
        "dependencies" in installed &&
          installed.dependencies &&
          typeof installed.dependencies === "object",
      );
      assert.deepEqual(Object.keys(installed.dependencies).sort(), [
        "issue-runner-core",
        "issue-runner-scripted",
      ]);
    },
  );
  writePlugin(
    join(globalRoot, "issue-runner-unrelated"),
    'throw new Error("unrelated plugins must never be imported");',
  );
  await t.test(
    "only the selected public import entry initializes, before an empty Run",
    () => {
      assert.equal(runInstalled("scripted").summary.outcome, "no_work");
      assert.equal(readFileSync(events, "utf8"), "module\ninitialized\n");
    },
  );
  const otherPlugin = join(
    consumer,
    "other prefix",
    "node_modules",
    "issue-runner-linked",
  );
  writePlugin(otherPlugin);
  symlinkSync(otherPlugin, join(globalRoot, "issue-runner-linked"), "junction");
  await t.test(
    "a sibling link cannot supply a plugin from another prefix",
    () => {
      const linked = runInstalled("linked");
      assert.equal(
        linked.exitCode,
        1,
        "must not load a plugin from another prefix",
      );
      assert.match(
        linked.summary.reasons.join(" "),
        /issue-runner-linked.*sibling/,
      );
      assert.equal(readFileSync(events, "utf8"), "module\ninitialized\n");
    },
  );
  await t.test(
    "invalid environment names fail before constructing a package name",
    () => {
      for (const name of [
        "../scripted",
        "@scope/plugin",
        "Scripted",
        "a/b",
        "a.b",
        "a--b",
        "-a",
        "a-",
        "a_b",
      ])
        assert.match(
          runInstalled(name).summary.reasons.join(" "),
          /valid --env name/,
        );
      assert.equal(readFileSync(events, "utf8"), "module\ninitialized\n");
    },
  );
  const missing = runInstalled("missing");
  assert.equal(missing.exitCode, 1);
  assert.match(missing.summary.reasons.join(" "), /issue-runner-missing/);
  assert.equal(missing.reads, 0);
  await t.test(
    "environment selection accepts names beyond built-in terminal brands",
    () => {
      writePlugin(join(globalRoot, "issue-runner-custom-2"));
      assert.equal(runInstalled("custom-2").summary.outcome, "no_work");
    },
  );
  for (const [source, reason] of [
    ["export const contractVersion = 2;", /contractVersion 1/],
    ["export const contractVersion = '1';", /contractVersion 1/],
    [
      "export default { contractVersion: 1, createTerminalPlugin() {} };",
      /contractVersion 1/,
    ],
    ["export const contractVersion = 1;", /zero-argument createTerminalPlugin/],
    [
      "export const contractVersion = 1; export const createTerminalPlugin = {};",
      /zero-argument createTerminalPlugin/,
    ],
    [
      "export const contractVersion = 1; export async function createTerminalPlugin(options) { throw new Error('must not call'); }",
      /zero-argument createTerminalPlugin/,
    ],
    [
      "export const contractVersion = 1; export async function createTerminalPlugin() { throw new Error('host context unavailable'); }",
      /host context unavailable/,
    ],
    [
      "export const contractVersion = 1; export async function createTerminalPlugin() { throw 'backend unavailable'; }",
      /backend unavailable/,
    ],
    [
      "export const contractVersion = 1; export async function createTerminalPlugin() { return null; }",
      /factory must return/,
    ],
    [
      "export const contractVersion = 1; export async function createTerminalPlugin() { return {}; }",
      /factory must return/,
    ],
    ["throw new Error('module load failed');", /module load failed/],
    ["import './missing-dependency.js';", /missing-dependency/],
    ["export const = ;", /Unexpected token/],
  ]) {
    assert.ok(typeof source === "string");
    assert.ok(reason instanceof RegExp);
    writeFileSync(join(plugin, "index.js"), source);
    const invalid = runInstalled("scripted");
    assert.equal(invalid.exitCode, 1);
    assert.equal(invalid.reads, 0);
    assert.match(
      invalid.summary.reasons.join(" "),
      /issue-runner-scripted.*same npm environment/,
    );
    assert.match(invalid.summary.reasons.join(" "), reason);
  }
  await t.test(
    "each returned method must be callable before workflow startup",
    () => {
      for (const method of ["createTab", "submitText", "closeTab"]) {
        writePlugin(
          plugin,
          `export const contractVersion = 1;
        export async function createTerminalPlugin() {
          return { createTab() {}, submitText() {}, closeTab() {}, ${method}: false };
        }`,
        );
        assert.match(
          runInstalled("scripted").summary.reasons.join(" "),
          /factory must return createTab, submitText, and closeTab methods/,
        );
      }
    },
  );
  await t.test(
    "broken package metadata and an unavailable public entry are actionable",
    () => {
      writePlugin(plugin);
      for (const metadata of [
        "{",
        JSON.stringify({ type: "module", exports: { ".": "./absent.js" } }),
        JSON.stringify({
          type: "module",
          exports: { "./private": "./index.js" },
        }),
      ]) {
        writeFileSync(join(plugin, "package.json"), metadata);
        assert.match(
          runInstalled("scripted").summary.reasons.join(" "),
          /Unable to load issue-runner-scripted:.*same npm environment/,
        );
      }
      writePlugin(plugin);
    },
  );
  await t.test(
    "Project packages, another prefix, PATH, NODE_PATH, and npm caches cannot substitute",
    () => {
      const otherPrefix = join(consumer, "fallback prefix");
      const otherRoot = npm(
        ["root", "--global", "--prefix", otherPrefix],
        consumer,
      ).trim();
      const cache = join(consumer, "cache");
      const cacheRoot = join(cache, "_npx", "cached", "node_modules");
      const bin = join(otherPrefix, "bin");
      mkdirSync(bin, { recursive: true });
      for (const directory of [
        join(launch, "demo", "node_modules"),
        join(launch, "node_modules"),
        otherRoot,
        cacheRoot,
        bin,
      ])
        writePlugin(join(directory, "issue-runner-scripted"));
      const hostileEnv = {
        ...process.env,
        PATH: `${bin}${delimiter}${process.env.PATH ?? ""}`,
        NODE_PATH: [otherRoot, cacheRoot].join(delimiter),
        npm_config_prefix: otherPrefix,
        npm_config_cache: cache,
      };
      const before = readFileSync(events, "utf8");
      writePlugin(plugin, "export const contractVersion = 99;");
      assert.match(
        runInstalled("scripted", hostileEnv).summary.reasons.join(" "),
        /contractVersion 1/,
      );
      renameSync(plugin, `${plugin}-saved`);
      try {
        assert.match(
          runInstalled("scripted", hostileEnv).summary.reasons.join(" "),
          /Unable to load issue-runner-scripted:.*same npm environment/,
        );
        assert.equal(readFileSync(events, "utf8"), before);
      } finally {
        renameSync(`${plugin}-saved`, plugin);
      }
      writePlugin(plugin);
      assert.equal(
        runInstalled("scripted", hostileEnv).summary.outcome,
        "no_work",
      );
      assert.equal(
        readFileSync(events, "utf8"),
        `${before}module\ninitialized\n`,
      );
    },
  );
  await t.test(
    "a nested Core dependency cannot masquerade as the selected sibling",
    () => {
      const nested = join(core, "node_modules", "issue-runner-scripted");
      writePlugin(nested);
      const before = readFileSync(events, "utf8");
      try {
        assert.match(
          runInstalled("scripted").summary.reasons.join(" "),
          /not the sibling/,
        );
        assert.equal(readFileSync(events, "utf8"), before);
      } finally {
        rmSync(nested, { recursive: true });
      }
    },
  );
  await t.test(
    "a public entry cannot escape the selected package through a link",
    () => {
      symlinkSync(otherPlugin, join(plugin, "linked-entry"), "junction");
      writeFileSync(
        join(plugin, "package.json"),
        JSON.stringify({
          name: "issue-runner-scripted",
          type: "module",
          exports: "./linked-entry/index.js",
        }),
      );
      const before = readFileSync(events, "utf8");
      assert.match(
        runInstalled("scripted").summary.reasons.join(" "),
        /not the sibling/,
      );
      assert.equal(readFileSync(events, "utf8"), before);
      writePlugin(plugin);
    },
  );
  await t.test(
    "a public entry with leading dots stays within the selected package",
    () => {
      renameSync(join(plugin, "index.js"), join(plugin, "..entry.js"));
      writeFileSync(
        join(plugin, "package.json"),
        JSON.stringify({
          name: "issue-runner-scripted",
          type: "module",
          exports: "./..entry.js",
        }),
      );
      const result = runInstalled("scripted");
      assert.equal(
        result.summary.outcome,
        "no_work",
        result.summary.reasons.join(" "),
      );
      writePlugin(plugin);
    },
  );
  await t.test(
    "a relocated global installation resolves beside the executing Core",
    () => {
      const relocated = join(consumer, "portable installation");
      renameSync(prefix, relocated);
      core = join(relocated, relative(prefix, globalRoot), "issue-runner-core");
      assert.equal(runInstalled("scripted").summary.outcome, "no_work");
      const bin = join(consumer, "entry");
      mkdirSync(bin);
      symlinkSync(core, join(bin, "core"), "junction");
      assert.equal(
        runNode([join(bin, "core", "dist/cli.js"), "--version"], launch).trim(),
        installedManifest.version,
      );
      core = join(bin, "core");
      assert.equal(runInstalled("scripted").summary.outcome, "no_work");
    },
  );
}
