/* eslint-disable @typescript-eslint/require-await -- Scripted external boundaries. */
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { promisify } from "node:util";
import { LocalGitWorkspace } from "../../src/adapters/git-workspace.ts";
import { executeCli } from "../../src/cli.ts";
import type { CreateTabOptions } from "../../src/terminal.ts";
import { failedCheck } from "../support/ci-repair-run.ts";
import { publicationRun } from "../support/publication-run.ts";
import {
  implementationCommand,
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

for (const emptyFirst of [false, true]) {
  await test(`real Git repairs preserve the original PR branch${emptyFirst ? " after rejecting an empty commit" : ""}`, async (t) => {
    const root = await mkdtemp(path.join(tmpdir(), "core-ci-git "));
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
    const fixture = await publicationRun(t, { ...validConfig, checkout });
    const workspace = new LocalGitWorkspace("unused-local-test-token");
    const push = workspace.push.bind(workspace);
    const pushed: { worktree: string; branch: string; head: string }[] = [];
    workspace.push = async (worktree, branch, head) => {
      const saved = await fixture.snapshot();
      const pending = saved.publication!.ciRepair?.attempts.at(-1);
      if (pending) assert.equal(pending.pendingPush, head);
      await push(worktree, branch, head);
      pushed.push({ worktree, branch, head });
      fixture.publicationState.pushes++;
      fixture.publicationState.branches.set(branch, head);
      for (const pr of fixture.publicationState.pullRequests) pr.headSha = head;
    };
    fixture.dependencies.codeHost.resolveTargetBranch = async () => "main";
    fixture.publicationState.onChecks = async () =>
      pushed.length === 1 ? [failedCheck] : [];
    const tabs = new Map<object, CreateTabOptions>();
    const configs: string[] = [];
    let repairs = 0;
    fixture.dependencies.terminalPlugin = {
      async createTab(options) {
        const tab = {};
        tabs.set(tab, options);
        configs.push(options.env.GIT_CONFIG_GLOBAL!);
        return tab;
      },
      async submitText(tab, text) {
        const options = tabs.get(tab)!;
        if (text.startsWith("Session Probe\n")) {
          const assignment = JSON.parse(text.split("\n")[1]!) as {
            path: string;
            role: string;
          };
          await publish(assignment.path, {
            ...assignment,
            sessionid: `native-${tabs.size}`,
            ...(assignment.role === "implement"
              ? {
                  pr_title: "fix: [issue-50] repair build",
                  pr_body: "Repair.\n\nCloses #50",
                }
              : {}),
          });
        } else if (
          text.startsWith("Implementation assignment\n") ||
          text.startsWith("CI repair assignment\n")
        ) {
          const assignment = JSON.parse(text.split("\n")[1]!) as {
            path: string;
          };
          const repair = text.startsWith("CI repair");
          const empty = repair && ++repairs === 1 && emptyFirst;
          if (!empty) {
            await writeFile(
              path.join(options.cwd, repair ? "fixed.txt" : "feature.txt"),
              "changed\n",
            );
            await git(options.cwd, "add", ".");
          }
          const message = repair ? "fix: required checks" : "feat: implement";
          await git(options.cwd, "commit", "--allow-empty", "-m", message);
          await publish(assignment.path, {
            outcome: "committed",
            summary: "Completed",
            commits: [
              { sha: await git(options.cwd, "rev-parse", "HEAD"), message },
            ],
            findings_file: null,
          });
        }
      },
      async closeTab(tab) {
        assert.ok(tabs.has(tab));
      },
    };
    const result = await executeCli(
      [...implementationCommand, "--no-auto-merge"],
      { ...fixture.dependencies, gitWorkspace: workspace },
    );
    assert.match(
      result.summary.reasons.join(" "),
      /CI-ready/u,
      JSON.stringify(result),
    );
    const saved = await fixture.snapshot();
    assert.equal(saved.base, base);
    assert.equal(saved.publication!.ciRepair!.consumed, emptyFirst ? 2 : 1);
    assert.equal(pushed.length, 2);
    assert.equal(pushed[0]!.branch, saved.branch);
    assert.equal(pushed[1]!.branch, saved.branch);
    assert.notEqual(pushed[1]!.worktree, saved.worktree);
    assert.equal(
      await git(origin, "rev-parse", `refs/heads/${saved.branch}`),
      pushed[1]!.head,
    );
    assert.equal(
      await git(pushed[1]!.worktree, "merge-base", pushed[0]!.head, "HEAD"),
      pushed[0]!.head,
    );
    assert.notEqual(
      await git(pushed[1]!.worktree, "branch", "--show-current"),
      saved.branch,
    );
    assert.equal(await git(origin, "rev-parse", "refs/heads/main"), base);
    assert.equal(await git(checkout, "rev-parse", "HEAD"), base);
    assert.equal(fixture.publicationState.creations, 1);
    for (const file of configs)
      await assert.rejects(readFile(file), { code: "ENOENT" });
  });
}
