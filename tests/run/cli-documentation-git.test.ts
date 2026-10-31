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
import { failedCheck } from "../support/ci-repair-run.ts";

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
  "repaired",
  "no_change",
  "ownership_changed",
  "branch_in_use",
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
      if (head) {
        fixture.publicationState.branches.set(branch, head);
        for (const pr of fixture.publicationState.pullRequests)
          if (pr.branch === branch) pr.headSha = head;
        fixture.integrationState.pullRequest.headSha = head;
      }
      return head || null;
    };
    fixture.state.onTask = async (file) => {
      const progress = await fixture.snapshot();
      assert.equal(await git(progress.worktree, "rev-parse", "HEAD"), base);
      const commits = [];
      if (scenario === "committed" || scenario === "repaired") {
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
    if (scenario === "repaired") {
      let repairs = 0;
      fixture.publicationState.onChecks = async () =>
        repairs < 2 ? [failedCheck] : [];
      const terminal = fixture.dependencies.terminalPlugin;
      const submit = terminal.submitText.bind(terminal);
      terminal.submitText = async (tab, text, chord) => {
        if (text.startsWith("Session Probe\n")) {
          const assignment = JSON.parse(text.split("\n")[1]!) as {
            role: string;
            path: string;
          };
          if (assignment.role === "ciRepair") {
            await publish(assignment.path, {
              ...assignment,
              sessionid: `native-repair-${repairs}`,
            });
            return;
          }
        }
        if (!text.startsWith("CI repair assignment\n"))
          return submit(tab, text, chord);
        const progress = await fixture.snapshot();
        const repair = progress.publication!.ciRepair!.attempts.at(-1)!;
        const commits = [];
        if (++repairs === 2) {
          await writeFile(path.join(repair.worktree, "README.md"), "fixed\n");
          await git(repair.worktree, "add", ".");
          const message = "docs: fix required checks";
          await git(repair.worktree, "commit", "-m", message);
          commits.push({
            sha: await git(repair.worktree, "rev-parse", "HEAD"),
            message,
          });
        }
        await publish(repair.invocation!.path, {
          outcome: commits.length ? "committed" : "no_change",
          summary: "Documentation repair checked",
          commits,
          findings_file: null,
        });
      };
    }
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
    const otherWorktree = path.join(fixture.directory, "other-worktree");
    if (scenario === "branch_in_use") {
      fixture.integrationState.onClose = async () => {
        fixture.state.ticket.state = "closed";
        fixture.state.ticket.stateReason = "completed";
        const progress = await fixture.snapshot();
        await git(
          checkout,
          "worktree",
          "add",
          "--force",
          otherWorktree,
          progress.branch,
        );
      };
      fixture.dependencies.operator.pause = async (message) => {
        assert.match(message, /used by worktree|checked out/u);
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
      scenario === "ownership_changed" || scenario === "branch_in_use"
        ? "cancelled"
        : "succeeded",
      JSON.stringify(result),
    );
    assert.equal(await git(checkout, "branch", "--show-current"), "main");
    assert.equal(await git(checkout, "rev-parse", "HEAD"), base);
    assert.equal(await git(checkout, "status", "--porcelain"), "");
    fixture.dependencies.operator.pause = async (message) => {
      assert.match(message, /ownership changed|used by worktree|checked out/u);
      return "";
    };
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
    if (scenario === "branch_in_use") {
      await assert.rejects(access(progress.worktree), { code: "ENOENT" });
      await access(otherWorktree);
      await access(progress.invocation!.path);
      assert.deepEqual(progress.cleanup?.worktrees, []);
      assert.equal(
        await git(checkout, "rev-parse", progress.branch),
        progress.base,
      );
      await git(checkout, "worktree", "remove", "--", otherWorktree);
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
    if (scenario === "repaired") {
      const attempts = progress.publication!.ciRepair!.attempts;
      assert.equal(attempts.length, 2);
      assert.equal(attempts[0]!.result?.outcome, "no_change");
      assert.equal(attempts[0]!.pushed, undefined);
      assert.equal(attempts[1]!.pushed, true);
      for (const repair of attempts) {
        await assert.rejects(access(repair.worktree), { code: "ENOENT" });
        assert.equal(
          await git(
            checkout,
            "for-each-ref",
            "--format=%(refname)",
            `refs/heads/${repair.branch}`,
          ),
          "",
        );
        for (const file of [repair.probe!.path, repair.invocation!.path]) {
          await assert.rejects(access(file), { code: "ENOENT" });
          await assert.rejects(access(`${file}.tmp`), { code: "ENOENT" });
        }
      }
    }
    assert.equal(
      fixture.state.closedTabs.length,
      scenario === "repaired" ? 3 : 1,
    );
  });
}
