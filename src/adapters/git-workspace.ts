import { execFile } from "node:child_process";
import { mkdir } from "node:fs/promises";
import path from "node:path";
import type { GitWorkspace, CommitEvidence } from "../run/contracts.ts";
import { formatToolError } from "./process-errors.ts";

// Extracted from sandcastle-runner at 0adf499bf69217b56256ca2affb1c0dca0894110.
export class LocalGitWorkspace implements GitWorkspace {
  private readonly token: string;

  constructor(token: string) {
    this.token = token;
  }

  private command(
    cwd: string,
    args: string[],
    remote = false,
  ): Promise<string> {
    const authorization = Buffer.from(`x-access-token:${this.token}`).toString(
      "base64",
    );
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
          env: {
            ...process.env,
            ...(remote
              ? {
                  GIT_CONFIG_COUNT: "1",
                  GIT_CONFIG_KEY_0: "http.https://github.com/.extraHeader",
                  GIT_CONFIG_VALUE_0: `Authorization: Basic ${authorization}`,
                }
              : {}),
          },
        },
        (error, stdout, stderr) => {
          if (!error) resolve(stdout);
          else
            reject(
              new Error(
                (stderr.trim() || formatToolError("git", error))
                  .replaceAll(this.token, "[redacted]")
                  .replaceAll(authorization, "[redacted]"),
              ),
            );
        },
      );
    });
  }

  async fetchTargetBranch(
    checkout: string,
    targetBranch: string,
  ): Promise<string> {
    await this.command(
      checkout,
      ["fetch", "--no-tags", "origin", targetBranch],
      true,
    );
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
      "worktree",
      "add",
      "-b",
      input.branch,
      input.worktree,
      input.base,
    ]);
  }

  async inspect({ worktree, base }: { worktree: string; base: string }) {
    const [actualPath, branch, actualBase, log, status, diff] =
      await Promise.all([
        this.command(worktree, ["rev-parse", "--show-toplevel"]),
        this.command(worktree, ["branch", "--show-current"]),
        this.command(worktree, ["merge-base", base, "HEAD"]),
        this.command(worktree, [
          "log",
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
    return {
      worktree: path.resolve(actualPath.trim()),
      branch: branch.trim(),
      base: actualBase.trim(),
      commits,
      clean: status === "",
      changed: diff !== "",
    };
  }
}
