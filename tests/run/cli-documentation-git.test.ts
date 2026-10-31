/* eslint-disable @typescript-eslint/require-await -- Scripted external boundaries. */
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { access, mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { promisify } from "node:util";
import { stringify } from "yaml";
import { LocalGitWorkspace } from "../../src/adapters/git-workspace.ts";
import { executeCli } from "../../src/cli.ts";
import {
  documentCommand,
  documentationRun,
} from "../support/documentation-run.ts";
import { publish } from "../support/implementation-run.ts";

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

for (const scenario of [
  "committed",
  "no_change",
  "ownership_changed",
] as const) {
  await test(`standalone documentation ${scenario} verifies real Git and cleans only owned resources`, async (t) => {
    const fixture = await documentationRun(t);
    const checkout = path.join(fixture.directory, "checkout");
    await mkdir(checkout);
    await git(checkout, "init", "--initial-branch=main");
    await writeFile(path.join(checkout, "README.md"), "initial\n");
    await git(checkout, "add", ".");
    await git(checkout, "commit", "-m", "Initial base");
    const base = await git(checkout, "rev-parse", "HEAD");
    const origin = path.join(fixture.directory, "origin.git");
    await git(fixture.directory, "clone", "--bare", checkout, origin);
    await git(checkout, "remote", "add", "origin", origin);
    const configPath = path.join(fixture.directory, "config.yaml");
    const { parse } = await import("yaml");
    const config = parse(await readFile(configPath, "utf8")) as Record<
      string,
      unknown
    >;
    await writeFile(
      configPath,
      stringify({ ...config, checkout, targetBranch: "main" }),
    );
    const workspace = new LocalGitWorkspace("unused-local-test-token");
    fixture.dependencies.codeHost.getRemoteBranchHead = async (
      _repository,
      branch,
    ) => {
      const head = await git(
        origin,
        "for-each-ref",
        "--format=%(objectname)",
        `refs/heads/${branch}`,
      );
      if (head) fixture.publicationState.branches.set(branch, head);
      return head || null;
    };
    fixture.state.onTask = async (file) => {
      const progress = await fixture.snapshot();
      assert.equal(await git(progress.worktree, "rev-parse", "HEAD"), base);
      const commits = [];
      if (scenario === "committed") {
        await writeFile(
          path.join(progress.worktree, "README.md"),
          "maintained\n",
        );
        await git(progress.worktree, "add", ".");
        await git(
          progress.worktree,
          "commit",
          "-m",
          "docs: maintain documentation",
        );
        const commit = {
          sha: await git(progress.worktree, "rev-parse", "HEAD"),
          message: "docs: maintain documentation",
        };
        commits.push(commit);
        fixture.integrationState.pullRequest.headSha = commit.sha;
      }
      await publish(file, {
        outcome: commits.length ? "committed" : "no_change",
        summary: "Documentation checked",
        commits,
        findings_file: null,
      });
    };
    if (scenario === "ownership_changed") {
      fixture.integrationState.onClose = async () => {
        fixture.state.ticket.state = "closed";
        fixture.state.ticket.stateReason = "completed";
        const progress = await fixture.snapshot();
        await git(progress.worktree, "switch", "-c", "someone-else");
        await writeFile(
          path.join(progress.worktree, "unrelated.txt"),
          "retain me\n",
        );
      };
      fixture.dependencies.operator.pause = async (message) => {
        assert.match(message, /ownership changed/u);
        return "q";
      };
    }
    const run = () =>
      executeCli(documentCommand, {
        ...fixture.dependencies,
        gitWorkspace: workspace,
      });
    const result = await run();
    const progress = await fixture.snapshot();
    assert.equal(
      result.summary.outcome,
      scenario === "ownership_changed" ? "cancelled" : "succeeded",
      JSON.stringify(result),
    );
    assert.equal(await git(checkout, "branch", "--show-current"), "main");
    assert.equal(await git(checkout, "rev-parse", "HEAD"), base);
    assert.equal(await git(checkout, "status", "--porcelain"), "");
    if (scenario === "ownership_changed") {
      assert.equal(
        await readFile(path.join(progress.worktree, "unrelated.txt"), "utf8"),
        "retain me\n",
      );
      await access(progress.invocation!.path);
      await git(progress.worktree, "clean", "-f");
      await git(progress.worktree, "switch", progress.branch);
      fixture.dependencies.signal = new AbortController().signal;
      assert.equal((await run()).summary.outcome, "succeeded");
      assert.equal(fixture.state.taskCount, 1);
      assert.equal(fixture.integrationState.closures, 1);
    }
    await assert.rejects(access(progress.worktree), { code: "ENOENT" });
    assert.equal(
      await git(
        checkout,
        "for-each-ref",
        "--format=%(refname)",
        `refs/heads/${progress.branch}`,
      ),
      "",
    );
    await assert.rejects(access(progress.invocation!.path), { code: "ENOENT" });
    assert.equal(fixture.state.closedTabs.length, 1);
  });
}
