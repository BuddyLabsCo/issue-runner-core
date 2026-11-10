import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import {
  copyFileSync,
  existsSync,
  readFileSync,
  readdirSync,
  statSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { createRequire } from "node:module";
import { basename, dirname, join } from "node:path";
import { pathToFileURL } from "node:url";
import { installEnhancement } from "../fixtures/enhancement-installation.mjs";

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
          basename(file) ===
            (windows ? "generic-terminal.cmd" : "generic-terminal") &&
          statSync(join(prefix, file)).isFile(),
      );
      assert.equal(executables.length, 1);
      assert.ok(executables[0]);
      const executable = join(prefix, executables[0]);
      /** @param {string[]} args @param {NodeJS.ProcessEnv} [env] */
      const cli = (args, env = process.env) =>
        execFileSync(windows ? `"${executable}"` : executable, args, {
          cwd: launch,
          env,
          encoding: "utf8",
          timeout: 30_000,
          // Windows needs a shell to execute npm's .cmd shim; quote paths with spaces.
          shell: windows,
        });
      assert.equal(
        cli(["--version"]).trim(),
        `generic-terminal 2.3.4 (core ${version})`,
      );
      assert.match(cli(["--help"]), /generic-terminal/);
      assert.doesNotMatch(cli(["run", "--help"]), /--env/);
      assert.match(cli(["run", "--help"]), /generic-terminal run --project/);
      assert.match(
        cli(["init", "--project", "demo"]),
        /then run generic-terminal run --project demo --parent/,
      );
      assert.throws(() => cli(["init", "--project", "demo"]), /Command failed/);
      for (const file of [
        "config.yaml",
        "prompts/implement.md",
        "prompts/review.md",
        "prompts/documentation.md",
      ])
        assert.ok(existsSync(join(launch, "demo", file)), file);

      const terminalFile = join(plugin, "terminal.js");
      const original = readFileSync(terminalFile, "utf8");
      const enhancement = join(dirname(plugin), "issue-runner-agent-codebuddy");
      try {
        writeFileSync(
          terminalFile,
          'export const contractVersion = 2; export function createTerminalPlugin() { throw new Error("terminal factory reached"); }',
        );
        for (const mode of ["absent", "mismatch", "broken"]) {
          if (mode !== "absent")
            installEnhancement(
              dirname(plugin),
              mode === "mismatch"
                ? 'export const contractVersion = 99; export function createEnhancement() { throw new Error("mismatched factory invoked"); }'
                : 'throw new Error("installed import failure");',
              "codebuddy",
            );
          assert.throws(
            () =>
              cli(["run", "--project", "demo", "--parent", "48"], {
                ...process.env,
                GH_TOKEN: "fixture-token",
              }),
            (error) => {
              assert.ok(
                error && typeof error === "object" && "stdout" in error,
              );
              const output = String(error.stdout);
              if (mode === "broken") {
                assert.match(
                  output,
                  /Unable to load issue-runner-agent-codebuddy: installed import failure/,
                );
                assert.doesNotMatch(output, /terminal factory reached/);
              } else {
                assert.match(output, /terminal factory reached/);
                assert.doesNotMatch(output, /mismatched factory invoked/);
                if (mode === "mismatch")
                  assert.match(
                    output,
                    /Skipping issue-runner-agent-codebuddy.*contractVersion 99.*base startup/,
                  );
              }
              return true;
            },
          );
        }
      } finally {
        writeFileSync(terminalFile, original);
        rmSync(enhancement, { recursive: true, force: true });
      }
    },
  );
  await t.test(
    "installed public types compile from the independent plugin",
    () => {
      copyFileSync(
        new URL("../fixtures/cli-consumer.mts", import.meta.url),
        join(plugin, "cli-consumer.mts"),
      );
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
          "cli-consumer.mts",
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
        const execution = executionTerminal({
          terminal: await terminalModule.createTerminalPlugin({}),
          progress: { ticket: 205, phase: "implementing" },
          async read(operation, target, action, settings) {
            policies.push([operation, settings?.retry]);
            return action();
          }
        });
        const { terminal } = execution;
        const pauses = [];
        const context = { cwd: process.cwd(), env: { CUSTOM: "literal $&" }, enhancementPause: (id, message) => pauses.push([id, message]) };
        const options = { ...context, label: "consumer", submitKey: "Shift+Enter", signal: new AbortController().signal };
        const { handle: tab, io } = await terminal.createTab(options);
        assert.equal(await terminal.execute(tab, "configured start"), undefined);
        await terminal.execute(tab, "configured resume native/$&");
        assert.equal(await io.read(), "visible plain text");
        await execution.submitText(() => io.submitText("task"));
        await io.sendKeys(["Control+C", "Right"]);
        await terminal.closeTab(tab);
        assert.deepEqual(events.splice(0), [
          ["terminal factory", {}], ["createTab", tab, options],
          ["execute", tab, "configured start", "Right", "Enter"],
          ["execute", tab, "configured resume native/$&", "Right", "Enter"],
          ["submitText", tab, "task", "Right", "Shift+Enter"],
          ["sendKeys", tab, ["Control+C", "Right"]], ["closeTab", tab]
        ]);
        await assert.rejects(terminal.closeTab(tab), /Unknown Issue Runner Tab/);
        await assert.rejects(io.read(), /Unknown Runner Tab/);
        assert.deepEqual(policies, [["create_tab", "manual"], ["execute_agent", "manual"], ["execute_agent", "manual"], ["submit_text", "never"]]);
        const hostEvents = [];
        let output = "native-ref";
        const host = {
          async read() { return output; },
          async submitText(text) { hostEvents.push(["text", text]); },
          async sendKeys(keys) { hostEvents.push(["keys", keys]); },
        };
        const enhancement = await enhancementModule.createEnhancement(host, async (id) => { hostEvents.push(["recovery", id]); }, context, { enabled: true });
        await enhancement.startMonitoring();
        assert.equal(await enhancement.waitUntilReady(), "native-ref");
        assert.equal(await enhancement.waitUntilReady(), "native-ref");
        assert.equal(enhancement.onAssignment({ id: "assignment-1", expectedFile: "/assigned.json" }), undefined);
        await enhancement.enhancementResume("assignment-1");
        assert.deepEqual(pauses, [["assignment-1", "Human action needed"]]);
        output = "";
        await assert.rejects(enhancement.waitUntilReady(), /Not ready/);
        await enhancement.stop();
        await assert.rejects(enhancement.waitUntilReady(), /Monitoring is stopped/);
        output = "another-ref";
        await enhancement.startMonitoring("saved-ref");
        assert.equal(await enhancement.waitUntilReady(), "saved-ref");
        await enhancement.stop();
        assert.deepEqual(events, [["enhancement factory", context, { enabled: true }], ["assignment", { id: "assignment-1", expectedFile: "/assigned.json" }], ["resume", "assignment-1"]]);
        assert.deepEqual(hostEvents, [
          ["keys", ["Right", "Enter"]], ["text", "readiness marker"], ["recovery", "assignment-1"],
          ["keys", ["Right", "Enter"]], ["text", "readiness marker"]
        ]);
      `,
        ],
        plugin,
      );
    },
  );
  await t.test("installed prompts and handoff skill files exist", () => {
    for (const file of [
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
      "prompts/handoff-correction.md",
      "prompts/recovery.md",
      "skills/issue-runner-handoff/SKILL.md",
    ])
      assert.ok(existsSync(join(core, file)), file);
  });
}
