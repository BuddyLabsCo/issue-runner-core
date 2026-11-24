import assert from "node:assert/strict";
import { mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test, { type TestContext } from "node:test";

import { LocalGitWorkspace } from "../../src/adapters/git-workspace.ts";

const executableTest = process.platform === "win32" ? test.skip : test;

await test("withAgentEnvironment returns an empty overlay without a temporary Git config", async (t) => {
  const directory = await mkdtemp(path.join(tmpdir(), "core-agent-env-"));
  t.after(() => rm(directory, { recursive: true, force: true }));

  const workspace = new LocalGitWorkspace();
  const overlay = await workspace.withAgentEnvironment(directory, (env) =>
    Promise.resolve(env),
  );

  assert.deepEqual(overlay, {});
  assert.deepEqual(await readdir(directory), []);
});

async function installFakeGit(t: TestContext) {
  const bin = await mkdtemp(path.join(tmpdir(), "core-git-bin-"));
  t.after(() => rm(bin, { recursive: true, force: true }));
  const originalPath = process.env.PATH;
  process.env.PATH = [bin, originalPath].join(path.delimiter);
  t.after(() => {
    process.env.PATH = originalPath;
  });
  return bin;
}

await executableTest(
  "fetch and push preserve the ambient Git environment",
  async (t) => {
    const bin = await installFakeGit(t);
    const directory = await mkdtemp(path.join(tmpdir(), "core-git-env-"));
    t.after(() => rm(directory, { recursive: true, force: true }));
    const log = path.join(directory, "git.log");
    await writeFile(
      path.join(bin, "git"),
      "#!/usr/bin/env node\n" +
        [
          'const assert = require("node:assert/strict");',
          'const fs = require("node:fs");',
          'assert.equal(process.env.GH_TOKEN, "ambient-token");',
          'assert.equal(process.env.GIT_CONFIG_KEY_0, "ambient-config-key");',
          'assert.equal(process.env.GIT_CONFIG_VALUE_0, "ambient-config-value");',
          `fs.appendFileSync(${JSON.stringify(log)}, process.argv.slice(2).join(" ") + "\\n");`,
          'if (process.argv[2] === "rev-parse") console.log("a".repeat(40));',
        ].join("\n"),
      { mode: 0o700 },
    );
    const inherited = {
      GH_TOKEN: process.env.GH_TOKEN,
      GIT_CONFIG_KEY_0: process.env.GIT_CONFIG_KEY_0,
      GIT_CONFIG_VALUE_0: process.env.GIT_CONFIG_VALUE_0,
    };
    process.env.GH_TOKEN = "ambient-token";
    process.env.GIT_CONFIG_KEY_0 = "ambient-config-key";
    process.env.GIT_CONFIG_VALUE_0 = "ambient-config-value";
    t.after(() => {
      for (const [name, value] of Object.entries(inherited)) {
        if (value === undefined) delete process.env[name];
        else process.env[name] = value;
      }
    });

    const workspace = new LocalGitWorkspace();
    assert.equal(
      await workspace.fetchTargetBranch(directory, "main"),
      "a".repeat(40),
    );
    await workspace.push(directory, "feature", "b".repeat(40));
    assert.deepEqual((await readFile(log, "utf8")).trim().split("\n"), [
      "fetch --no-tags origin main",
      "rev-parse FETCH_HEAD",
      "check-ref-format refs/heads/feature",
      "push origin bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb:refs/heads/feature",
    ]);
  },
);
