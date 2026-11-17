import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { promisify } from "node:util";
import { LocalGitWorkspace } from "../../src/adapters/git-workspace.ts";

const execute = promisify(execFile);

await test("Agent Git rewrites GitHub SSH remotes and keeps the configured authorization", async (t) => {
  const directory = await mkdtemp(path.join(tmpdir(), "git-credential-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  await execute("git", ["init"], { cwd: directory });
  await execute(
    "git",
    ["remote", "add", "origin", "git@github.com:owner/repo.git"],
    { cwd: directory },
  );
  const workspace = new LocalGitWorkspace("token");
  await workspace.withAgentEnvironment(directory, async (env) => {
    for (const url of [
      "git@github.com:owner/repo.git",
      "ssh://git@github.com/owner/repo.git",
      "ssh://github.com/owner/repo.git",
    ]) {
      await execute("git", ["config", "remote.origin.url", url], {
        cwd: directory,
      });
      const { stdout } = await execute("git", ["remote", "get-url", "origin"], {
        cwd: directory,
        env: { ...process.env, ...env, GIT_CONFIG_NOSYSTEM: "1" },
      });
      assert.equal(stdout.trim(), "https://github.com/owner/repo.git");
    }
    const { stdout } = await execute(
      "git",
      ["config", "--get", "http.https://github.com/.extraHeader"],
      {
        cwd: directory,
        env: { ...process.env, ...env, GIT_CONFIG_NOSYSTEM: "1" },
      },
    );
    assert.equal(
      stdout.trim(),
      `Authorization: Basic ${Buffer.from("x-access-token:token").toString("base64")}`,
    );
  });
});

await test(
  "Runner Git remote operations receive the SSH rewrites and authorization",
  { skip: process.platform === "win32" },
  async (t) => {
    const directory = await mkdtemp(path.join(tmpdir(), "fake-git-"));
    const previousPath = process.env.PATH;
    t.after(async () => {
      process.env.PATH = previousPath;
      await rm(directory, { recursive: true, force: true });
    });
    await writeFile(
      path.join(directory, "git"),
      '#!/bin/sh\nif [ "$1" = fetch ]; then env > "$GIT_TEST_CAPTURE"; else printf "%040d\\n" 1; fi\n',
      { mode: 0o755 },
    );
    process.env.PATH = `${directory}${path.delimiter}${previousPath ?? ""}`;
    process.env.GIT_TEST_CAPTURE = path.join(directory, "capture");
    t.after(() => {
      delete process.env.GIT_TEST_CAPTURE;
    });
    await new LocalGitWorkspace("token").fetchTargetBranch(directory, "main");
    const { readFile } = await import("node:fs/promises");
    const capture = await readFile(path.join(directory, "capture"), "utf8");
    assert.match(capture, /GIT_CONFIG_VALUE_1=git@github.com:/u);
    assert.match(capture, /GIT_CONFIG_VALUE_2=ssh:\/\/git@github.com\//u);
    assert.match(capture, /GIT_CONFIG_VALUE_3=ssh:\/\/github.com\//u);
    assert.match(
      capture,
      new RegExp(Buffer.from("x-access-token:token").toString("base64"), "u"),
    );
  },
);
