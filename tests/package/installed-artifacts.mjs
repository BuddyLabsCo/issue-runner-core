import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import {
  copyFileSync,
  readFileSync,
  readdirSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import { createRequire } from "node:module";
import { basename, join } from "node:path";
import { pathToFileURL } from "node:url";
import { stringify } from "yaml";
import { validConfig } from "../support/cli-project.ts";

/**
 * @param {import("node:test").TestContext} t
 * @param {{ core: string, plugin: string, prefix: string, launch: string, version: string,
 *   runNode: (args: string[], cwd: string, env?: NodeJS.ProcessEnv) => string }} options
 */
export async function testInstalledArtifacts(
  t,
  { core, plugin, prefix, launch, version, runNode },
) {
  await t.test(
    "npm's installed executable runs outside the checkout and initializes bundled templates",
    () => {
      const windows = process.platform === "win32";
      const executables = readdirSync(prefix, {
        recursive: true,
        encoding: "utf8",
      }).filter(
        (file) =>
          basename(file) === (windows ? "issue-runner.cmd" : "issue-runner"),
      );
      assert.equal(executables.length, 1);
      assert.ok(executables[0]);
      const executable = join(prefix, executables[0]);
      /** @param {string[]} args */
      const cli = (args) =>
        execFileSync(windows ? `"${executable}"` : executable, args, {
          cwd: launch,
          encoding: "utf8",
          timeout: 30_000,
          // Windows needs a shell to execute npm's .cmd shim; quote paths with spaces.
          shell: windows,
        });
      assert.equal(cli(["--version"]).trim(), version);
      assert.match(cli(["--help"]), /issue-runner/);
      assert.match(cli(["run", "--help"]), /--env/);
      assert.match(cli(["init", "--project", "demo"]), /Initialized Project/);
      for (const file of [
        "config.yaml",
        "prompts/implement.md",
        "prompts/review.md",
        "prompts/documentation.md",
      ])
        assert.deepEqual(
          readFileSync(join(launch, "demo", file)),
          readFileSync(join(core, "templates", file)),
        );
    },
  );
  await t.test(
    "installed public types compile from the independent plugin",
    () => {
      copyFileSync(
        new URL("../fixtures/terminal-consumer.mts", import.meta.url),
        join(plugin, "consumer.mts"),
      );
      copyFileSync(
        new URL("../fixtures/plugin-implementations.mts", import.meta.url),
        join(plugin, "implementations.mts"),
      );
      runNode(
        [
          createRequire(import.meta.url).resolve("typescript/bin/tsc"),
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
          "implementations.mts",
        ],
        plugin,
      );
      assert.equal(
        readFileSync(join(plugin, "output/consumer.mjs"), "utf8").trim(),
        "export {};",
      );
      runNode(
        [
          "--input-type=module",
          "--eval",
          `
        import assert from "node:assert/strict";
        import { terminalModule, enhancementModule, events } from "./output/implementations.mjs";
        const { executionTerminal } = await import(${JSON.stringify(pathToFileURL(join(core, "dist/run/cleanup.js")).href)});
        const policies = [];
        const terminal = executionTerminal({
          terminal: await terminalModule.createTerminalPlugin({}),
          progress: { ticket: 205, phase: "implementing" },
          async read(operation, target, action, settings) {
            policies.push([operation, settings?.retry]);
            return action();
          }
        }).terminal;
        const context = { cwd: process.cwd(), env: { CUSTOM: "literal $&" } };
        const options = { ...context, label: "consumer", agent: "opaque-agent", submitKey: "Shift+Enter", signal: new AbortController().signal };
        const tab = await terminal.createTab(options);
        assert.equal(await terminal.start(tab, "configured start"), undefined);
        assert.equal(await terminal.resume(tab, "configured resume", "native/$&"), "native/$&");
        await terminal.submitText(tab, "task", undefined, "/assigned.json", "continue unfinished work");
        await terminal.submitText(tab, "shell command", "Enter");
        await terminal.closeTab(tab);
        assert.deepEqual(events.splice(0), [
          ["terminal factory", {}], ["createTab", tab, options],
          ["start", tab, "configured start"], ["resume", tab, "configured resume", "native/$&"],
          ["submitText", tab, "task", "Shift+Enter", "/assigned.json", "continue unfinished work"],
          ["submitText", tab, "shell command", "Enter", undefined, undefined], ["closeTab", tab]
        ]);
        await assert.rejects(terminal.closeTab(tab), /Unknown Issue Runner Tab/);
          assert.deepEqual(policies, [["create_tab", "manual"], ["start_agent", "manual"], ["resume_agent", "manual"], ["submit_text", "never"], ["submit_text", "never"]]);
        const identified = { ...options, env: { NATIVE_REF: "returned-native-ref" } };
        const identifiedTab = await terminal.createTab(identified);
        assert.equal(await terminal.start(identifiedTab, "identified start"), "returned-native-ref");
        await terminal.closeTab(identifiedTab);
        assert.deepEqual(events.splice(0), [["createTab", identifiedTab, identified], ["start", identifiedTab, "identified start"], ["closeTab", identifiedTab]]);
        const hostEvents = [];
        let output = "native-ref";
        const host = {
          async read() { return output; },
          async submitText(text) { hostEvents.push(["text", text]); },
          async sendKeys(keys) { hostEvents.push(["keys", keys]); },
          async requestRecovery(...args) { assert.equal(args.length, 0); hostEvents.push(["recovery"]); }
        };
        const enhancement = await enhancementModule.createEnhancement(host, context, { enabled: true });
        await enhancement.startMonitoring();
        assert.equal(await enhancement.waitUntilReady(), "native-ref");
        assert.equal(await enhancement.waitUntilReady(), "native-ref");
        assert.equal(enhancement.onAssignment("/assigned.json"), undefined);
        output = "";
        await assert.rejects(enhancement.waitUntilReady(), /Not ready/);
        await enhancement.stop();
        await assert.rejects(enhancement.waitUntilReady(), /Monitoring is stopped/);
        output = "another-ref";
        await enhancement.startMonitoring("saved-ref");
        assert.equal(await enhancement.waitUntilReady(), "saved-ref");
        await enhancement.stop();
        assert.deepEqual(events, [["enhancement factory", context, { enabled: true }], ["assignment", "/assigned.json"]]);
        assert.deepEqual(hostEvents, [
          ["keys", ["Right", "Enter"]], ["text", "readiness marker"], ["recovery"],
          ["keys", ["Right", "Enter"]], ["text", "readiness marker"]
        ]);
      `,
        ],
        plugin,
      );
    },
  );
  await t.test(
    "installed purpose prompts load and the manual handoff asset matches exactly",
    () => {
      runNode(
        [
          "--input-type=module",
          "--eval",
          `
      import assert from "node:assert/strict";
      import { readFileSync } from "node:fs";
      import { join } from "node:path";
      import { pathToFileURL } from "node:url";
      const core = ${JSON.stringify(core)};
      for (const [file, name, asset, expected] of [
        ["implement", "implementationInstructions", "implement", "Implement issue #{{issue}}"],
        ["review", "reviewInstructions", "review", "issue requirements"],
        ["review", "reviewFixInstructions", "review-fix", "assigned review report"],
        ["documentation", "documentationInstructions", "documentation", "Maintain the documentation requested"],
        ["ci-repair", "ciRepairInstructions", "ci-repair", "Fix the failed required checks"],
        ["conflict-repair", "conflictRepairInstructions", "conflict-repair", "Resolve the pull request merge conflict"],
        ["session", "probeInstructions", "probe", "actual native conversation session ID"],
        ["session", "probeCorrectionInstructions", "probe-correction", "Correct the previous Probe"],
        ["session", "resumeInstructions", "resume", "continue"],
        ["session", "handoffCorrectionInstructions", "handoff-correction", "Correct the {{name}} handoff"]
      ]) {
        const prompts = await import(pathToFileURL(join(core, "dist/prompts", file + ".js")).href);
        assert.equal(typeof prompts[name], "string", name);
        assert.ok(prompts[name].includes(expected), name);
        assert.equal(prompts[name], readFileSync(join(core, "prompts", asset + ".md"), "utf8").trimEnd(), name);
        assert.deepEqual(
          readFileSync(join(core, "prompts", asset + ".md")),
          readFileSync(new URL("../../prompts/" + asset + ".md", ${JSON.stringify(import.meta.url)}))
        );
      }
    `,
        ],
        launch,
      );
      assert.deepEqual(
        readFileSync(join(core, "skills/issue-runner-handoff/SKILL.md")),
        readFileSync(
          new URL(
            "../../skills/issue-runner-handoff/SKILL.md",
            import.meta.url,
          ),
        ),
      );
    },
  );
  await t.test("installed prompts cannot fall back to the checkout", () => {
    const assets = join(core, "prompts");
    renameSync(assets, `${assets}.unavailable`);
    try {
      assert.throws(
        () => runNode([join(core, "dist/cli.js"), "--version"], launch),
        /ENOENT.*prompts/,
      );
    } finally {
      renameSync(`${assets}.unavailable`, assets);
    }
  });
}

/**
 * @param {import("node:test").TestContext} t
 * @param {{ globalRoot: string, launch: string, validPlugin: string,
 *   writePlugin: (directory: string, source?: string) => void,
 *   runInstalled: (environment: string) => { summary: { outcome: unknown } } }} options
 */
export async function testPluginConfiguration(
  t,
  { globalRoot, launch, validPlugin, writePlugin, runInstalled },
) {
  const plugin = join(globalRoot, "issue-runner-scripted");
  await t.test(
    "environment selection accepts names beyond built-in terminal brands",
    () => {
      writePlugin(
        join(globalRoot, "issue-runner-custom-2"),
        validPlugin.replace("(config)", "(config = { defaulted: true })"),
      );
      assert.equal(runInstalled("custom-2").summary.outcome, "no_work");
    },
  );
  await t.test(
    "selected factories receive complete opaque terminalPlugins regardless of environment",
    () => {
      const terminalPlugins = {
        scripted: {
          nativeOptions: [null, false, 0, "  preserve whitespace  "],
        },
        "custom-2": { enhancement: "not-installed", enabled: true },
        arbitrary: { nested: [{ timeout: -1, options: {} }] },
      };
      const source = validPlugin.replace(
        "assert.deepEqual(config, {});",
        `assert.deepEqual(config, ${JSON.stringify(terminalPlugins)});`,
      );
      writeFileSync(
        join(launch, "demo/config.yaml"),
        stringify({ ...validConfig, targetBranch: "main", terminalPlugins }),
      );
      try {
        for (const environment of ["scripted", "custom-2"]) {
          writePlugin(join(globalRoot, `issue-runner-${environment}`), source);
          const result = runInstalled(environment);
          assert.equal(
            result.summary.outcome,
            "no_work",
            JSON.stringify(result),
          );
        }
      } finally {
        writePlugin(plugin);
        writePlugin(join(globalRoot, "issue-runner-custom-2"));
        writeFileSync(
          join(launch, "demo/config.yaml"),
          stringify({ ...validConfig, targetBranch: "main" }),
        );
      }
    },
  );
}
