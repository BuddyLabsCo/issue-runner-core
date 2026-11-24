import { execFile } from "node:child_process";
import { mkdir, realpath } from "node:fs/promises";
import path from "node:path";
import type { GitWorkspace, CommitEvidence } from "../run/contracts.ts";
import { formatToolError } from "./process-errors.ts";

async function resolveWorktreePath(directory: string): Promise<string> {
  try {
    return await realpath(directory);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT")
      return path.resolve(directory);
    throw error;
  }
}

// Extracted from sandcastle-runner at 0adf499bf69217b56256ca2affb1c0dca0894110.
export class LocalGitWorkspace implements GitWorkspace {
  async withAgentEnvironment<T>(
    _directory: string,
    action: (env: Readonly<Record<string, string>>) => Promise<T>,
  ): Promise<T> {
    return action({});
  }

  private command(cwd: string, args: string[]): Promise<string> {
    return new Promise((resolve, reject) => {
      execFile(
        "git",
        args,
        {
          cwd,
          encoding: "utf8",
          shell: false,
          timeout: 60_000,
          maxBuffer: 10 * 1024 * 1024,
        },
        (error, stdout, stderr) => {
          if (!error) resolve(stdout);
          else
            reject(new Error(stderr.trim() || formatToolError("git", error)));
        },
      );
    });
  }

  async fetchTargetBranch(
    checkout: string,
    targetBranch: string,
  ): Promise<string> {
    await this.command(checkout, [
      "fetch",
      "--no-tags",
      "origin",
      targetBranch,
    ]);
    const base = (
      await this.command(checkout, ["rev-parse", "FETCH_HEAD"])
    ).trim();
    if (!/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/u.test(base))
      throw new Error("Invalid fetched Git SHA");
    return base;
  }

  async createWorktree(input: {
    checkout: string;
    worktree: string;
    branch: string;
    base: string;
  }): Promise<void> {
    await mkdir(path.dirname(input.worktree), { recursive: true });
    await this.command(input.checkout, [
      "-c",
      "core.longpaths=true",
      "worktree",
      "add",
      "-b",
      input.branch,
      input.worktree,
      input.base,
    ]);
  }

  async push(worktree: string, branch: string, headSha: string): Promise<void> {
    if (!/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/u.test(headSha))
      throw new Error("Invalid publication head SHA");
    await this.command(worktree, ["check-ref-format", `refs/heads/${branch}`]);
    await this.command(worktree, [
      "push",
      "origin",
      `${headSha}:refs/heads/${branch}`,
    ]);
  }

  async cleanupWorktree(input: {
    checkout: string;
    worktree: string;
    branch: string;
    headSha: string;
  }): Promise<void> {
    const { checkout, worktree, branch, headSha } = input;
    await this.command(checkout, ["check-ref-format", `refs/heads/${branch}`]);
    const head = (
      await this.command(checkout, [
        "for-each-ref",
        "--format=%(objectname)",
        `refs/heads/${branch}`,
      ])
    ).trim();
    if (head && head !== headSha)
      throw new Error("Cleanup branch head changed; retaining resources");
    const entries = (
      await this.command(checkout, [
        "-c",
        "core.longpaths=true",
        "worktree",
        "list",
        "--porcelain",
        "-z",
      ])
    ).split("\0\0");
    const expectedPath = await resolveWorktreePath(worktree);
    let owned: string | undefined;
    for (const entry of entries) {
      const field = entry
        .split("\0")
        .find((field) => field.startsWith("worktree "));
      if (
        field &&
        (await resolveWorktreePath(field.slice(9))) === expectedPath
      ) {
        owned = entry;
        break;
      }
    }
    if (owned) {
      if (!owned.split("\0").includes(`branch refs/heads/${branch}`))
        throw new Error(
          "Cleanup Worktree ownership changed; retaining resources",
        );
      await this.command(checkout, [
        "-c",
        "core.longpaths=true",
        "worktree",
        "remove",
        "--",
        worktree,
      ]);
    }
    if (head) await this.command(checkout, ["branch", "-D", "--", branch]);
  }

  async inspect({ worktree, base }: { worktree: string; base: string }) {
    const [actualPath, branch, actualBase, head, log, status, diff] =
      await Promise.all([
        this.command(worktree, ["rev-parse", "--show-toplevel"]),
        this.command(worktree, ["branch", "--show-current"]),
        this.command(worktree, ["merge-base", base, "HEAD"]),
        this.command(worktree, ["rev-parse", "HEAD"]),
        this.command(worktree, [
          "log",
          "--topo-order",
          "--reverse",
          "--format=%H%x00%s",
          `${base}..HEAD`,
        ]),
        this.command(worktree, [
          "status",
          "--porcelain",
          "--untracked-files=all",
        ]),
        this.command(worktree, ["diff", "--name-only", base, "HEAD"]),
      ]);
    const commits: CommitEvidence[] =
      log.trimEnd() === ""
        ? []
        : log
            .trimEnd()
            .split("\n")
            .map((line) => {
              const separator = line.indexOf("\0");
              if (separator < 0) throw new Error("Invalid Git commit evidence");
              return {
                sha: line.slice(0, separator),
                message: line.slice(separator + 1),
              };
            });
    if ((commits.at(-1)?.sha ?? actualBase.trim()) !== head.trim())
      throw new Error("Git commit evidence does not end at HEAD");
    const actualWorktree = await resolveWorktreePath(actualPath.trim());
    const expectedWorktree = await resolveWorktreePath(worktree);
    return {
      // Preserve the requested spelling only after proving filesystem identity.
      worktree:
        actualWorktree === expectedWorktree
          ? path.resolve(worktree)
          : actualWorktree,
      branch: branch.trim(),
      base: actualBase.trim(),
      commits,
      clean: status === "",
      changed: diff !== "",
    };
  }
}
