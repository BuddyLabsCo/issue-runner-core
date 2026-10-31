/* eslint-disable @typescript-eslint/require-await -- Scripted external boundaries. */
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { promisify } from "node:util";
import { LocalGitWorkspace } from "../../src/adapters/git-workspace.ts";
import { executeCli } from "../../src/cli.ts";
import type { CreateTabOptions } from "../../src/terminal.ts";
import { child, parentRun } from "../support/parent-run.ts";
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

for (const scenario of [
  "changed",
  "empty",
  "remote-advance",
  "dirty-cancel",
] as const) {
  await test(`a real Git ${scenario} execution is independently checked through a complete Run`, async (t) => {
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
    let observations = 0;
    let advancedHead = "";
    fixture.dependencies.codeHost.getRemoteBranchHead = async (
      _repository,
      branch,
    ) => {
      const observed =
        (await git(
          origin,
          "for-each-ref",
          "--format=%(objectname)",
          `refs/heads/${branch}`,
        )) || null;
      if (scenario === "remote-advance" && ++observations === 2) {
        // Advance after the observation, before Core's real non-forced push.
        await git(origin, "switch", "-c", branch);
        await writeFile(path.join(origin, "someone-else.txt"), "remote work\n");
        await git(origin, "add", ".");
        await git(origin, "commit", "-m", "Someone else's work");
        advancedHead = await git(origin, "rev-parse", "HEAD");
      }
      return observed;
    };
    if (scenario === "remote-advance")
      fixture.dependencies.operator.pause = async (message) => {
        assert.match(message, /advanced or disappeared/u);
        return "q";
      };
    fixture.state.onTask = async (file) => {
      const progress = await fixture.snapshot();
      if (scenario === "dirty-cancel") {
        await writeFile(
          path.join(progress.worktree, "README.md"),
          "uncommitted edit\n",
        );
        await git(progress.worktree, "add", "README.md");
        await writeFile(
          path.join(progress.worktree, "untracked.txt"),
          "unfinished work\n",
        );
        await writeFile(`${file}.tmp`, "partial handoff");
        fixture.controller.abort();
        return;
      }
      if (scenario !== "empty") {
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
      scenario === "empty" || scenario === "dirty-cancel"
        ? "implementing"
        : "implementation_completed",
    );
    assert.equal(await git(checkout, "branch", "--show-current"), "main");
    assert.equal(await git(checkout, "rev-parse", "HEAD"), base);
    assert.equal(
      await git(progress.worktree, "branch", "--show-current"),
      progress.branch,
    );
    assert.equal(
      await git(checkout, "rev-parse", `refs/heads/${progress.branch}`),
      await git(progress.worktree, "rev-parse", "HEAD"),
    );
    if (scenario === "dirty-cancel") {
      assert.match(
        await git(progress.worktree, "status", "--porcelain"),
        /M {2}README\.md\n\?\? untracked\.txt/u,
      );
      assert.equal(
        await readFile(path.join(progress.worktree, "README.md"), "utf8"),
        "uncommitted edit\n",
      );
      assert.equal(
        await readFile(path.join(progress.worktree, "untracked.txt"), "utf8"),
        "unfinished work\n",
      );
      assert.ok(
        fixture.dependencies.messages.some(
          (message) =>
            message.startsWith("Retained ") &&
            message.includes(progress.worktree),
        ),
      );
    }
    if (scenario !== "empty" && scenario !== "dirty-cancel") {
      assert.equal(
        await git(origin, "rev-parse", `refs/heads/${progress.branch}`),
        scenario === "remote-advance"
          ? advancedHead
          : progress.result!.commits[0]!.sha,
      );
      assert.equal(await git(origin, "rev-parse", "refs/heads/main"), base);
    }
  });
}

await test("a concurrent Batch uses a fresh fetched base and isolated real Git Worktrees and configurations", async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), "core-batch-git "));
  t.after(() => rm(root, { recursive: true, force: true }));
  const origin = path.join(root, "origin");
  const checkout = path.join(root, "checkout");
  await mkdir(origin);
  await git(origin, "init", "--initial-branch=main");
  await writeFile(path.join(origin, "README.md"), "initial\n");
  await git(origin, "add", ".");
  await git(origin, "commit", "-m", "Initial base");
  const initial = await git(origin, "rev-parse", "HEAD");
  await git(root, "clone", origin, checkout);
  await writeFile(path.join(origin, "README.md"), "fresh target\n");
  await git(origin, "commit", "-am", "Advance Target Branch");
  const fresh = await git(origin, "rev-parse", "HEAD");
  const fixture = await parentRun(t, [child(51), child(52)], {
    ...validConfig,
    checkout,
    maxBatchSize: 2,
  });
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
  const tabs = new Map<object, CreateTabOptions>();
  const closed = new Set<object>();
  const configs: string[] = [];
  const inheritedConfig = process.env.GIT_CONFIG_GLOBAL;
  let release!: () => void;
  const bothTasks = new Promise<void>((resolve) => {
    release = resolve;
  });
  let tasks = 0;
  const result = await executeCli(
    ["run", "--project", "demo", "--env", "fake", "--parent", "48"],
    {
      ...fixture.dependencies,
      gitWorkspace: new LocalGitWorkspace("unused-local-test-token"),
      terminalPlugin: {
        async createTab(options) {
          const tab = {};
          tabs.set(tab, options);
          configs.push(options.env.GIT_CONFIG_GLOBAL!);
          const { stdout } = await execute(
            "git",
            ["config", "--global", "--get", "user.name"],
            {
              cwd: options.cwd,
              env: { ...process.env, ...options.env },
              encoding: "utf8",
            },
          );
          assert.equal(stdout.trim(), "Issue Runner");
          return tab;
        },
        async submitText(tab, text) {
          const options = tabs.get(tab)!;
          const number = Number(/ticket-(\d+)$/u.exec(options.cwd)![1]);
          if (text.startsWith("Session Probe\n")) {
            const assignment = JSON.parse(text.split("\n")[1]!) as {
              path: string;
              ticket: number;
            };
            assert.equal(assignment.ticket, number);
            await publish(assignment.path, {
              ...assignment,
              sessionid: `native-${number}`,
              pr_title: `feat: [issue-${number}] implement`,
              pr_body: `Implement.\n\nCloses #${number}`,
            });
          } else if (text.startsWith("Implementation assignment\n")) {
            const assignment = JSON.parse(text.split("\n")[1]!) as {
              path: string;
            };
            assert.ok(text.includes(`Base SHA: ${fresh}`));
            assert.equal(await git(options.cwd, "rev-parse", "HEAD"), fresh);
            if (++tasks === 2) release();
            await bothTasks;
            await writeFile(
              path.join(options.cwd, `issue-${number}.txt`),
              `Issue #${number}\n`,
            );
            await git(options.cwd, "add", ".");
            const message = `feat: implement Issue #${number}`;
            await git(options.cwd, "commit", "-m", message);
            await publish(assignment.path, {
              outcome: "committed",
              summary: `Implemented #${number}`,
              commits: [
                { sha: await git(options.cwd, "rev-parse", "HEAD"), message },
              ],
              findings_file: null,
            });
          }
        },
        async closeTab(tab) {
          assert.equal(tabs.has(tab), true);
          assert.equal(closed.has(tab), false);
          closed.add(tab);
        },
      },
    },
  );
  assert.equal(
    result.summary.outcome,
    "incomplete",
    JSON.stringify(result.summary),
  );
  assert.equal(tasks, 2);
  assert.equal(closed.size, 2);
  assert.equal(new Set(configs).size, 2);
  assert.equal(process.env.GIT_CONFIG_GLOBAL, inheritedConfig);
  for (const file of configs)
    await assert.rejects(readFile(file), { code: "ENOENT" });
  for (const { cwd } of tabs.values()) {
    const own = Number(/ticket-(\d+)$/u.exec(cwd)![1]);
    const other = own === 51 ? 52 : 51;
    assert.equal(
      await readFile(path.join(cwd, `issue-${own}.txt`), "utf8"),
      `Issue #${own}\n`,
    );
    await assert.rejects(readFile(path.join(cwd, `issue-${other}.txt`)), {
      code: "ENOENT",
    });
    assert.equal(await git(cwd, "status", "--porcelain"), "");
    assert.equal(await git(cwd, "merge-base", fresh, "HEAD"), fresh);
  }
  assert.equal(await git(checkout, "branch", "--show-current"), "main");
  assert.equal(await git(checkout, "rev-parse", "HEAD"), initial);
});
