import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import {
  access,
  mkdir,
  mkdtemp,
  realpath,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { promisify } from "node:util";
import { LocalGitWorkspace } from "../../src/adapters/git-workspace.ts";
import { verifyWorkspace } from "../../src/run/verification.ts";

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

for (const aliasKind of ["directory", "short"] as const) {
  await test(`real Git verifies and cleans the same Worktree through a ${aliasKind} alias`, async (t) => {
    if (aliasKind === "short" && process.platform !== "win32") {
      t.skip("Windows 8.3 paths require Windows");
      return;
    }
    const root = await mkdtemp(path.join(tmpdir(), "core-path "));
    t.after(() => rm(root, { recursive: true, force: true }));
    const physical = await realpath(root);
    let alias: string;
    if (aliasKind === "directory") {
      alias = path.join(root, "alias");
      await mkdir(path.join(root, "physical"));
      await symlink(
        path.join(physical, "physical"),
        alias,
        process.platform === "win32" ? "junction" : "dir",
      );
    } else {
      const { stdout } = await execute(
        "cmd.exe",
        ["/d", "/c", `for %I in ("${physical}") do @echo %~sI`],
        { encoding: "utf8", timeout: 60_000, windowsVerbatimArguments: true },
      );
      alias = stdout.trim();
      if (alias === physical) {
        t.skip("No distinct 8.3 alias is available on this volume");
        return;
      }
    }
    const checkout = path.join(root, "checkout");
    await mkdir(checkout);
    await git(checkout, "init", "--initial-branch=main");
    await writeFile(path.join(checkout, "README.md"), "initial\n");
    await git(checkout, "add", ".");
    await git(checkout, "commit", "-m", "Initial base");
    const base = await git(checkout, "rev-parse", "HEAD");
    const workspace = new LocalGitWorkspace("unused-local-test-token");
    const worktree = path.join(alias, "ticket-50");
    const expected = { worktree, base, branch: "issue-50" };
    await workspace.createWorktree({ checkout, ...expected });
    const canonical = await realpath(worktree);
    assert.notEqual(worktree, canonical);
    assert.equal(await realpath(canonical), await realpath(worktree));
    await writeFile(path.join(worktree, "feature.txt"), "implementation\n");
    await git(worktree, "add", ".");
    await git(worktree, "commit", "-m", "Implement the Issue");
    const sha = await git(worktree, "rev-parse", "HEAD");
    const result = {
      outcome: "committed" as const,
      summary: "Implemented",
      commits: [{ sha, message: "Implement the Issue" }],
      findings_file: null,
    };
    const evidence = await workspace.inspect(expected);
    verifyWorkspace(expected, evidence, result);
    verifyWorkspace(
      { ...expected, worktree: canonical },
      await workspace.inspect({ worktree: canonical, base }),
      result,
    );
    assert.throws(
      () =>
        verifyWorkspace({ ...expected, worktree: checkout }, evidence, result),
      /Worktree path mismatch/u,
    );
    const nested = path.join(worktree, "nested");
    await mkdir(nested);
    const nestedEvidence = await workspace.inspect({ worktree: nested, base });
    assert.throws(
      () =>
        verifyWorkspace(
          { ...expected, worktree: nested },
          nestedEvidence,
          result,
        ),
      /Worktree path mismatch/u,
    );
    const cleanup = {
      checkout,
      worktree,
      branch: expected.branch,
      headSha: sha,
    };
    await assert.rejects(
      workspace.cleanupWorktree({ ...cleanup, worktree: checkout }),
      /ownership changed/u,
    );
    await assert.rejects(
      workspace.cleanupWorktree({ ...cleanup, headSha: base }),
      /branch head changed/u,
    );
    await writeFile(path.join(worktree, "dirty.txt"), "unfinished\n");
    await assert.rejects(workspace.cleanupWorktree(cleanup));
    await access(worktree);
    await rm(path.join(worktree, "dirty.txt"));
    await git(worktree, "switch", "-c", "foreign-owner");
    await assert.rejects(
      workspace.cleanupWorktree(cleanup),
      /ownership changed/u,
    );
    await access(worktree);
    await git(worktree, "switch", expected.branch);
    await workspace.cleanupWorktree(cleanup);
    await assert.rejects(access(canonical), { code: "ENOENT" });
    assert.equal(
      await git(
        checkout,
        "for-each-ref",
        "--format=%(refname)",
        "refs/heads/issue-50",
      ),
      "",
    );
    await workspace.cleanupWorktree(cleanup);
    await access(checkout);
  });
}
