import assert from "node:assert/strict";
import { copyFileSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { join } from "node:path";

/**
 * @param {import("node:test").TestContext} t
 * @param {{ core: string, plugin: string, prefix: string, launch: string, version: string,
 *   npm: (args: string[], cwd: string) => string,
 *   runNode: (args: string[], cwd: string, env?: NodeJS.ProcessEnv) => string }} options
 */
export async function testInstalledArtifacts(
  t,
  { core, plugin, prefix, launch, version, npm, runNode },
) {
  await t.test(
    "npm's installed executable runs outside the checkout and initializes bundled templates",
    () => {
      /** @param {string[]} args */
      const cli = (args) =>
        npm(
          [
            "exec",
            "--global",
            "--prefix",
            prefix,
            "--offline",
            "--no",
            "--",
            "issue-runner",
            ...args,
          ],
          launch,
        );
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
      import { join } from "node:path";
      import { pathToFileURL } from "node:url";
      const core = ${JSON.stringify(core)};
      for (const [file, name, expected] of [
        ["implement", "implementationInstructions", "Implement the accepted Issue"],
        ["review", "reviewInstructions", "Standards"],
        ["review", "reviewFixInstructions", "original implementation conversation"],
        ["documentation", "documentationInstructions", "Maintain the project documentation"],
        ["ci-repair", "ciRepairInstructions", "Diagnose the failed required checks"],
        ["conflict-repair", "conflictRepairInstructions", "resolve the explicit merge conflict"]
      ]) {
        const prompts = await import(pathToFileURL(join(core, "dist/prompts", file + ".js")).href);
        assert.equal(typeof prompts[name], "string", name);
        assert.ok(prompts[name].includes(expected), name);
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
}
