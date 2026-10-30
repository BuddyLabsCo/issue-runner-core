/* eslint-disable @typescript-eslint/require-await -- Scripted external boundaries. */
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { promisify } from "node:util";
import { LocalGitWorkspace } from "../../src/adapters/git-workspace.ts";
import { executeCli } from "../../src/cli.ts";
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

for (const scenario of ["changed", "empty"] as const) {
  await test(`a real Git ${scenario} commit is independently checked through a complete Run`, async (t) => {
    const root = await mkdtemp(path.join(tmpdir(), "core-git "));
    t.after(() => rm(root, { recursive: true, force: true }));
    const origin = path.join(root, "origin");
    const checkout = path.join(root, "checkout");
    await mkdir(origin);
    await git(origin, "init", "--initial-branch=main");
    await writeFile(path.join(origin, "README.md"), "initial\n");
    await git(origin, "add", ".");
    await git(origin, "commit", "-m", "Initial base");
    const base = await git(origin, "rev-parse", "HEAD");
    await git(root, "clone", origin, checkout);
    const fixture = await implementationRun(t, {
      ...validConfig,
      checkout,
      agentRetry: 0,
    });
    fixture.dependencies.codeHost.resolveTargetBranch = async () => "main";
    fixture.state.onTask = async (file) => {
      const progress = await fixture.snapshot();
      if (scenario === "changed") {
        await writeFile(
          path.join(progress.worktree, "feature.txt"),
          "implementation\n",
        );
        await git(progress.worktree, "add", ".");
      }
      await git(
        progress.worktree,
        "commit",
        "--allow-empty",
        "-m",
        "feat: implement the Issue",
      );
      await publish(file, {
        outcome: "committed",
        summary: "Implemented the Issue.",
        commits: [
          {
            sha: await git(progress.worktree, "rev-parse", "HEAD"),
            message: "feat: implement the Issue",
          },
        ],
        findings_file: null,
      });
    };
    fixture.state.onSleep = async (ms) => {
      if (ms === 250) fixture.controller.abort();
    };
    const result = await executeCli(implementationCommand, {
      ...fixture.dependencies,
      gitWorkspace: new LocalGitWorkspace("unused-local-test-token"),
    });
    const progress = await fixture.snapshot();
    assert.equal(progress.base, base);
    assert.equal(
      result.summary.outcome,
      scenario === "changed" ? "incomplete" : "cancelled",
      JSON.stringify(result),
    );
    assert.equal(
      progress.phase,
      scenario === "changed" ? "implementation_completed" : "implementing",
    );
    assert.equal(await git(checkout, "branch", "--show-current"), "main");
    assert.equal(await git(checkout, "rev-parse", "HEAD"), base);
  });
}
