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
  publish,
} from "../support/implementation-run.ts";
import { findings, passed, reviewRun } from "../support/review-run.ts";

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

await test("real Git rejects reviewer edits, verifies a final-round fix against reviewed HEAD, and retains both verified commits", async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), "core-review-git "));
  t.after(() => rm(root, { recursive: true, force: true }));
  const origin = path.join(root, "origin");
  const checkout = path.join(root, "checkout");
  await mkdir(origin);
  await git(origin, "init", "--initial-branch=main");
  await writeFile(path.join(origin, "feature.txt"), "base\n");
  await git(origin, "add", ".");
  await git(origin, "commit", "-m", "Initial base");
  const base = await git(origin, "rev-parse", "HEAD");
  await git(root, "clone", origin, checkout);
  const fixture = await reviewRun(t, 1, { checkout });
  fixture.dependencies.codeHost.resolveTargetBranch = async () => "main";
  let implementationHead = "";
  fixture.state.onTask = async (file) => {
    const saved = await fixture.snapshot();
    await writeFile(path.join(saved.worktree, "feature.txt"), "implemented\n");
    await git(saved.worktree, "add", ".");
    await git(saved.worktree, "commit", "-m", "feat: implement");
    implementationHead = await git(saved.worktree, "rev-parse", "HEAD");
    await publish(file, {
      outcome: "committed",
      summary: "Implemented locally.",
      commits: [{ sha: implementationHead, message: "feat: implement" }],
      findings_file: null,
    });
  };
  fixture.reviewState.onReview = async (round) => {
    assert.equal(round.base, base);
    assert.equal(round.head, implementationHead);
    const saved = await fixture.snapshot();
    await writeFile(
      path.join(saved.worktree, "feature.txt"),
      "unauthorized reviewer edit\n",
    );
    await publish(round.invocation!.path, passed());
  };
  fixture.reviewState.onCorrection = async (round, purpose) => {
    assert.equal(purpose, "review");
    assert.match(
      fixture.state.submissions.at(-1)!.text,
      /Worktree must be clean/u,
    );
    const saved = await fixture.snapshot();
    await writeFile(path.join(saved.worktree, "feature.txt"), "implemented\n");
    await findings(round);
  };
  fixture.reviewState.onFix = async (round) => {
    const saved = await fixture.snapshot();
    await writeFile(
      path.join(saved.worktree, "feature.txt"),
      "implemented and fixed\n",
    );
    await git(saved.worktree, "add", ".");
    await git(saved.worktree, "commit", "-m", "fix: address findings");
    await publish(round.fix!.invocation!.path, {
      outcome: "committed",
      summary: "Fixed all findings.",
      commits: [
        {
          sha: await git(saved.worktree, "rev-parse", "HEAD"),
          message: "fix: address findings",
        },
      ],
      findings_file: null,
    });
  };
  const result = await executeCli(implementationCommand, {
    ...fixture.dependencies,
    gitWorkspace: new LocalGitWorkspace("unused-test-token"),
  });
  assert.match(result.summary.reasons.join(" "), /eligible for publication/u);
  const saved = await fixture.snapshot();
  assert.equal(saved.phase, "publication_eligible");
  const log = await git(
    saved.worktree,
    "log",
    "--reverse",
    "--format=%s",
    `${base}..HEAD`,
  );
  assert.equal(log, "feat: implement\nfix: address findings");
  assert.equal(await git(saved.worktree, "status", "--porcelain"), "");
  assert.equal(await git(checkout, "rev-parse", "HEAD"), base);
  assert.equal(await git(checkout, "branch", "--show-current"), "main");
  assert.equal(fixture.state.closedTabs.length, 3);
});
