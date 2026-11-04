import assert from "node:assert/strict";
import { mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { testInstalledArtifacts } from "./installed-artifacts.mjs";

/**
 * @param {import("node:test").TestContext} t
 * @param {{ consumer: string, artifact: string,
 *   npm: (args: string[], cwd: string) => string,
 *   runNode: (args: string[], cwd: string, env?: NodeJS.ProcessEnv) => string }} options
 */
export async function testTerminalCommand(
  t,
  { consumer, artifact, npm, runNode },
) {
  const prefix = join(consumer, "global prefix");
  const globalRoot = npm(
    ["root", "--global", "--prefix", prefix],
    consumer,
  ).trim();
  const launch = join(consumer, "launch");
  const source = join(consumer, "private command");
  const artifacts = join(consumer, "command artifacts");
  for (const directory of [launch, source, artifacts]) mkdirSync(directory);
  writeFileSync(
    join(source, "package.json"),
    JSON.stringify({
      name: "generic-terminal",
      version: "2.3.4",
      private: true,
      type: "module",
      bin: { "generic-terminal": "command.js" },
      dependencies: { "issue-runner-core": `file:${artifact}` },
    }),
  );
  writeFileSync(
    join(source, "command.js"),
    `#!/usr/bin/env node
    import { runCli } from "issue-runner-core/cli";
    import * as terminal from "./terminal.js";
    await runCli({ commandName: "generic-terminal", commandVersion: "2.3.4", terminal });
  `,
  );
  writeFileSync(
    join(source, "terminal.js"),
    `
    import { terminalContractVersion } from "issue-runner-core/terminal";
    export const contractVersion = terminalContractVersion;
    export async function createTerminalPlugin() {
      throw new Error("informational commands and init must not call the factory");
    }
  `,
  );
  npm(["pack", "--ignore-scripts", "--pack-destination", artifacts], source);
  const tarballs = readdirSync(artifacts).filter((file) =>
    file.endsWith(".tgz"),
  );
  assert.equal(tarballs.length, 1);
  assert.ok(tarballs[0]);
  npm(
    [
      "install",
      "--global",
      "--prefix",
      prefix,
      "--ignore-scripts",
      "--no-audit",
      "--no-fund",
      join(artifacts, tarballs[0]),
    ],
    launch,
  );
  const plugin = join(globalRoot, "generic-terminal");
  const core = dirname(
    dirname(
      createRequire(join(plugin, "package.json")).resolve(
        "issue-runner-core/terminal",
      ),
    ),
  );
  /** @type {unknown} */
  const manifest = JSON.parse(readFileSync(join(core, "package.json"), "utf8"));
  assert.ok(manifest && typeof manifest === "object");
  assert.ok("version" in manifest && typeof manifest.version === "string");
  assert.ok(!("bin" in manifest));
  /** @type {unknown} */
  const installed = JSON.parse(
    npm(["ls", "--global", "--prefix", prefix, "--depth=0", "--json"], launch),
  );
  assert.ok(installed && typeof installed === "object");
  assert.ok(
    "dependencies" in installed &&
      installed.dependencies &&
      typeof installed.dependencies === "object",
  );
  assert.deepEqual(Object.keys(installed.dependencies), ["generic-terminal"]);
  await testInstalledArtifacts(t, {
    core,
    plugin,
    prefix,
    launch,
    version: manifest.version,
    runNode,
  });
}
