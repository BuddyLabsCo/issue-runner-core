import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { copyFileSync, readFileSync, readdirSync, renameSync } from "node:fs";
import { createRequire } from "node:module";
import { basename, join } from "node:path";
import { pathToFileURL } from "node:url";

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
      renameSync(executable, `${executable}.unavailable`);
      try {
        assert.throws(
          () => cli(["--version"]),
          "a local executable must not replace the missing global executable",
        );
      } finally {
        renameSync(`${executable}.unavailable`, executable);
      }
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
        ],
        plugin,
      );
      assert.equal(
        readFileSync(join(plugin, "output/consumer.mjs"), "utf8").trim(),
        "export {};",
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
        ["implement", "implementationInstructions", "implement", "Implement the accepted Issue"],
        ["review", "reviewInstructions", "review", "Standards"],
        ["review", "reviewFixInstructions", "review-fix", "original implementation conversation"],
        ["documentation", "documentationInstructions", "documentation", "Maintain the project documentation"],
        ["ci-repair", "ciRepairInstructions", "ci-repair", "Diagnose the failed required checks"],
        ["conflict-repair", "conflictRepairInstructions", "conflict-repair", "resolve the explicit merge conflict"],
        ["session", "probeInstructions", "probe", "actual native conversation sessionid"],
        ["session", "probeMetadataInstructions", "probe-metadata", "Generate complete pr_title and pr_body"],
        ["session", "probeReviewInstructions", "probe-review", "independent reviewer identity"],
        ["session", "probeRepairInstructions", "probe-repair", "native repair identity"],
        ["session", "probeCorrectionInstructions", "probe-correction", "Correct the previous Probe"],
        ["session", "handoffInvocationInstructions", "handoff-invocation", "sole absolute output-path argument"],
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
  await t.test(
    "installed CLI preserves startup, Probe, task, correction and continuation submissions",
    () => {
      runNode(
        [
          "--input-type=module",
          "--eval",
          `
          import test from "node:test";
          const { executeCli } = await import(${JSON.stringify(pathToFileURL(join(core, "dist/cli.js")).href)});
          const { testPromptAssembly, testPromptContinuation } = await import(${JSON.stringify(new URL("../support/prompt-assembly.ts", import.meta.url).href)});
          await test("installed prompt assembly", t => testPromptAssembly(t, executeCli));
          await test("installed continuation", t => testPromptContinuation(t, executeCli));
          `,
        ],
        launch,
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
