/* eslint-disable @typescript-eslint/require-await -- Scripted external boundaries. */
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import {
  access,
  mkdir,
  mkdtemp,
  realpath,
  readlink,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test, { type TestContext } from "node:test";
import { promisify } from "node:util";
import { LocalGitWorkspace } from "../../src/adapters/git-workspace.ts";
import { executeCli } from "../../src/cli.ts";
import { verifyWorkspace } from "../../src/run/verification.ts";
import {
  implementationCommand,
  implementationRun,
  publish,
} from "../support/implementation-run.ts";
import { validConfig } from "../support/cli-project.ts";

const execute = promisify(execFile);
async function git(cwd: string, ...args: string[]) {
  const { stdout } = await execute(
    "git",
    [
      "-c",
      "user.name=Test",
      "-c",
      "user.email=test@example.com",
      "-c",
      "commit.gpgsign=false",
      ...args,
    ],
    { cwd, encoding: "utf8", timeout: 60_000 },
  );
  return stdout.trim();
}

for (const [mismatch, message] of [
  ["foreign", /Worktree path mismatch/u],
  ["subdirectory", /Worktree path mismatch/u],
  ["branch", /Delivery branch mismatch/u],
  ["base", /Base SHA mismatch/u],
  ["dirty", /Worktree must be clean/u],
  ["commits", /Claimed commits/u],
] as const) {
  await test(`real Git alias inspection preserves ${mismatch} verification`, async (t) => {
    const { root, checkout, base } = await repository(t);
    const alias = await directoryAlias(t, root, "directory");
    assert.ok(alias);
    const workspace = new LocalGitWorkspace("unused-local-test-token");
    const worktree = path.join(alias, "ticket-50");
    const branch = "issue-test";
    await workspace.createWorktree({ checkout, worktree, branch, base });
    const expected = { worktree, branch, base };
    if (mismatch === "foreign") expected.worktree = checkout;
    if (mismatch === "subdirectory") {
      expected.worktree = path.join(worktree, "nested");
      await mkdir(expected.worktree);
    }
    if (mismatch === "branch") await git(worktree, "switch", "-c", "foreign");
    if (mismatch === "base") expected.base = "f".repeat(40);
    if (mismatch === "dirty")
      await writeFile(path.join(worktree, "untracked.txt"), "retain me\n");
    const evidence = await workspace.inspect({
      worktree: mismatch === "subdirectory" ? expected.worktree : worktree,
      base,
    });
    assert.throws(
      () =>
        verifyWorkspace(expected, evidence, {
          outcome: "no_change",
          summary: "Claimed no changes.",
          findings_file: null,
          commits:
            mismatch === "commits"
              ? [{ sha: "b".repeat(40), message: "Unclaimed work" }]
              : [],
        }),
      message,
    );
    await access(worktree);
  });
}

for (const changed of [
  "dirty",
  "branch",
  "head",
  "foreign",
  "subdirectory",
] as const) {
  await test(`real Git cleanup through an alias retains resources with ${changed} ownership evidence`, async (t) => {
    const { root, checkout, base } = await repository(t);
    const alias = await directoryAlias(t, root, "directory");
    assert.ok(alias);
    const workspace = new LocalGitWorkspace("unused-local-test-token");
    const worktree = path.join(alias, "ticket-50");
    const branch = "issue-test";
    await workspace.createWorktree({ checkout, worktree, branch, base });
    const foreign = path.join(root, "foreign");
    await git(checkout, "worktree", "add", "-b", "foreign", foreign, base);
    let requested = worktree;
    if (changed === "dirty" || changed === "head")
      await writeFile(path.join(worktree, "untracked.txt"), "retain me\n");
    if (changed === "head") {
      await git(worktree, "add", ".");
      await git(worktree, "commit", "-m", "Unverified branch advance");
    }
    if (changed === "branch") await git(worktree, "switch", "-c", "other");
    if (changed === "foreign") requested = path.join(alias, "foreign");
    if (changed === "subdirectory") {
      requested = path.join(worktree, "nested");
      await mkdir(requested);
    }
    await assert.rejects(
      workspace.cleanupWorktree({
        checkout,
        worktree: requested,
        branch,
        headSha: base,
      }),
      /retaining resources|untracked files|used by worktree|checked out/u,
    );
    await access(worktree);
    await access(foreign);
    assert.ok(
      await git(
        checkout,
        "for-each-ref",
        "--format=%(refname)",
        `refs/heads/${branch}`,
      ),
    );
    assert.equal(await git(foreign, "branch", "--show-current"), "foreign");
    assert.equal(await git(checkout, "rev-parse", "HEAD"), base);
    if (changed === "dirty" || changed === "head")
      await access(path.join(worktree, "untracked.txt"));
  });
}

async function repository(t: TestContext) {
  const root = await realpath(
    await mkdtemp(path.join(tmpdir(), "core-worktree-paths ")),
  );
  t.after(() => rm(root, { recursive: true, force: true }));
  const checkout = path.join(root, "checkout");
  await mkdir(checkout);
  await git(checkout, "init", "--initial-branch=main");
  await writeFile(path.join(checkout, "README.md"), "base\n");
  await git(checkout, "add", ".");
  await git(checkout, "commit", "-m", "Initial base");
  return { root, checkout, base: await git(checkout, "rev-parse", "HEAD") };
}

async function directoryAlias(
  t: TestContext,
  directory: string,
  kind: "directory" | "8.3",
) {
  const physical = await realpath(directory);
  let alias: string;
  if (kind === "8.3") {
    const { stdout } = await execute(
      "cmd.exe",
      ["/d", "/c", 'for %I in ("%WORKTREE_PATH_TEST%") do @echo %~sI'],
      {
        env: { ...process.env, WORKTREE_PATH_TEST: physical },
        windowsVerbatimArguments: true,
        timeout: 60_000,
      },
    );
    alias = stdout.trim();
    if (path.resolve(alias) === physical) {
      t.skip("No Windows 8.3 alias exists on this volume");
      return;
    }
  } else {
    alias = path.join(physical, "directory-alias");
    await symlink(physical, alias, "junction");
  }
  assert.notEqual(path.resolve(alias), physical);
  assert.equal(await realpath(alias), physical);
  return alias;
}

await test(
  "real Git cleanup ignores unreadable unrelated Worktrees but rejects an unreadable requested path",
  { skip: process.platform === "win32" },
  async (t) => {
    const { root, checkout, base } = await repository(t);
    const alias = await directoryAlias(t, root, "directory");
    assert.ok(alias);
    const workspace = new LocalGitWorkspace("unused-local-test-token");
    const foreign = path.join(root, "a-foreign");
    await workspace.createWorktree({
      checkout,
      worktree: foreign,
      branch: "foreign",
      base,
    });
    const worktree = path.join(alias, "z-owned");
    const branch = "owned";
    await workspace.createWorktree({ checkout, worktree, branch, base });
    await rm(foreign, { recursive: true });
    await symlink(foreign, foreign, "dir");
    await assert.rejects(realpath(foreign), { code: "ELOOP" });

    const input = { checkout, worktree, branch, headSha: base };
    await workspace.cleanupWorktree(input);
    await workspace.cleanupWorktree(input);
    await assert.rejects(access(worktree), { code: "ENOENT" });
    assert.equal(
      await git(
        checkout,
        "for-each-ref",
        "--format=%(refname)",
        "refs/heads/owned",
      ),
      "",
    );

    await assert.rejects(
      workspace.cleanupWorktree({
        checkout,
        worktree: path.join(alias, "a-foreign"),
        branch: "foreign",
        headSha: base,
      }),
      { code: "ELOOP" },
    );
    assert.equal(await readlink(foreign), foreign);
    assert.equal(await git(checkout, "rev-parse", "refs/heads/foreign"), base);
    assert.equal(await git(checkout, "branch", "--show-current"), "main");
  },
);

for (const kind of ["directory", "8.3"] as const) {
  await test(
    `real Git verifies recovered delivery through a ${kind} alias`,
    { skip: kind === "8.3" && process.platform !== "win32" },
    async (t) => {
      const { root, checkout, base } = await repository(t);
      const origin = path.join(root, "origin.git");
      await git(root, "clone", "--bare", checkout, origin);
      await git(checkout, "remote", "add", "origin", origin);
      const fixture = await implementationRun(t, {
        ...validConfig,
        checkout,
        agentRetry: 0,
      });
      const alias = await directoryAlias(
        t,
        fixture.dependencies.launchDirectory,
        kind,
      );
      if (!alias) return;
      fixture.dependencies.launchDirectory = alias;
      fixture.dependencies.codeHost.resolveTargetBranch = async () => "main";
      fixture.dependencies.codeHost.getRemoteBranchHead = async (
        _repository,
        branch,
      ) =>
        (await git(
          origin,
          "for-each-ref",
          "--format=%(objectname)",
          `refs/heads/${branch}`,
        )) || null;
      fixture.state.onTask = async (file) => {
        const saved = await fixture.snapshot();
        assert.notEqual(saved.worktree, await realpath(saved.worktree));
        await writeFile(path.join(saved.worktree, "feature.txt"), "changed\n");
        await git(saved.worktree, "add", ".");
        const message = "feat: implement through an alias";
        await git(saved.worktree, "commit", "-m", message);
        await publish(file, {
          outcome: "committed",
          summary: "Implemented through an alias.",
          commits: [
            { sha: await git(saved.worktree, "rev-parse", "HEAD"), message },
          ],
          findings_file: null,
        });
        fixture.controller.abort();
      };
      const dependencies = {
        ...fixture.dependencies,
        gitWorkspace: new LocalGitWorkspace("unused-local-test-token"),
      };
      const first = await executeCli(implementationCommand, dependencies);
      assert.equal(first.summary.outcome, "cancelled", JSON.stringify(first));
      const interrupted = await fixture.snapshot();
      const result = await executeCli(implementationCommand, {
        ...dependencies,
        signal: new AbortController().signal,
      });
      assert.match(
        result.summary.reasons.join(" "),
        /CI-ready/u,
        JSON.stringify(result),
      );
      const saved = await fixture.snapshot();
      assert.equal(saved.worktree, interrupted.worktree);
      assert.equal(saved.execution_id, interrupted.execution_id);
      assert.equal(fixture.state.taskCount, 1);
      assert.equal(await git(checkout, "rev-parse", "HEAD"), base);
      assert.equal(
        await git(origin, "rev-parse", `refs/heads/${saved.branch}`),
        saved.result!.commits[0]!.sha,
      );
    },
  );

  for (const missing of [false, true]) {
    await test(
      `real Git cleanup through a ${kind} alias removes only owned resources${missing ? " after the directory disappeared" : ""}`,
      { skip: kind === "8.3" && process.platform !== "win32" },
      async (t) => {
        const { root, checkout, base } = await repository(t);
        const alias = await directoryAlias(t, root, kind);
        if (!alias) return;
        const workspace = new LocalGitWorkspace("unused-local-test-token");
        const worktree = path.join(alias, "ticket-50");
        const branch = "issue-test";
        await workspace.createWorktree({ checkout, worktree, branch, base });
        const foreign = path.join(root, "foreign");
        await git(checkout, "worktree", "add", "-b", "foreign", foreign, base);
        if (missing) await rm(worktree, { recursive: true });
        const input = { checkout, worktree, branch, headSha: base };
        await workspace.cleanupWorktree(input);
        await workspace.cleanupWorktree(input);
        await assert.rejects(access(path.join(root, "ticket-50")), {
          code: "ENOENT",
        });
        assert.equal(
          await git(
            checkout,
            "for-each-ref",
            "--format=%(refname)",
            `refs/heads/${branch}`,
          ),
          "",
        );
        assert.equal(await git(foreign, "branch", "--show-current"), "foreign");
        assert.equal(await git(checkout, "rev-parse", "HEAD"), base);
        assert.equal(await git(checkout, "branch", "--show-current"), "main");
      },
    );
  }
}
