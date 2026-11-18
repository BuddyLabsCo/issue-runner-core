import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { promisify } from "node:util";
import { LocalGitWorkspace } from "../../src/adapters/git-workspace.ts";

const execute = promisify(execFile);

await test("GitHub SSH origins use HTTPS for Runner fetch and push and Agent Git", async (t) => {
  const directory = await mkdtemp(path.join(tmpdir(), "git-credential-"));
  const previous = process.env.GIT_ALLOW_PROTOCOL;
  t.after(async () => {
    if (previous === undefined) delete process.env.GIT_ALLOW_PROTOCOL;
    else process.env.GIT_ALLOW_PROTOCOL = previous;
    await rm(directory, { recursive: true, force: true });
  });
  await execute("git", ["init", directory]);
  process.env.GIT_ALLOW_PROTOCOL = "file";
  const workspace = new LocalGitWorkspace("secret-token");
  for (const origin of [
    "git@github.com:owner/repo.git",
    "ssh://git@github.com/owner/repo.git",
  ]) {
    await execute("git", ["remote", "remove", "origin"], {
      cwd: directory,
    }).catch(() => undefined);
    await execute("git", ["remote", "add", "origin", origin], {
      cwd: directory,
    });
    for (const operation of [
      () => workspace.fetchTargetBranch(directory, "main"),
      () => workspace.push(directory, "feature", "a".repeat(40)),
    ]) {
      await assert.rejects(operation(), (error: unknown) => {
        assert.ok(error instanceof Error);
        assert.match(error.message, /transport 'https' not allowed/);
        assert.doesNotMatch(error.message, /secret-token/);
        return true;
      });
    }
    await workspace.withAgentEnvironment(directory, async (env) => {
      const options = { cwd: directory, env: { ...process.env, ...env } };
      const remote = await execute(
        "git",
        ["remote", "get-url", "origin"],
        options,
      );
      assert.equal(remote.stdout.trim(), "https://github.com/owner/repo.git");
      const auth = await execute(
        "git",
        [
          "config",
          "--get-urlmatch",
          "http.extraHeader",
          "https://github.com/owner/repo.git",
        ],
        options,
      );
      assert.equal(
        auth.stdout.trim(),
        `Authorization: Basic ${Buffer.from("x-access-token:secret-token").toString("base64")}`,
      );
    });
  }
});
