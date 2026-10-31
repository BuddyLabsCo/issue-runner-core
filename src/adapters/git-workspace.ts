import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdir, realpath, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import type { GitWorkspace, CommitEvidence } from "../run/contracts.ts";
import { formatToolError } from "./process-errors.ts";

// Extracted from sandcastle-runner at 0adf499bf69217b56256ca2affb1c0dca0894110.
export class LocalGitWorkspace implements GitWorkspace {
  private readonly token: string;

  constructor(token: string) {
    this.token = token;
  }

  async withAgentEnvironment<T>(
    directory: string,
    action: (env: Readonly<Record<string, string>>) => Promise<T>,
  ): Promise<T> {
    const file = path.resolve(directory, `git-config-${randomUUID()}`);
    const authorization = Buffer.from(`x-access-token:${this.token}`).toString(
      "base64",
    );
    try {
      await writeFile(
        file,
        `[user]\n\tname = Issue Runner\n\temail = issue-runner@users.noreply.github.com\n[http "https://github.com/"]\n\textraHeader = Authorization: Basic ${authorization}\n`,
        { mode: 0o600 },
      );
      return await action({ GIT_CONFIG_GLOBAL: file });
    } finally {
      await rm(file, { force: true });
    }
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

  async push(worktree: string, branch: string, headSha: string): Promise<void> {
    if (!/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/u.test(headSha))
      throw new Error("Invalid publication head SHA");
    await this.command(worktree, ["check-ref-format", `refs/heads/${branch}`]);
    await this.command(
      worktree,
      ["push", "origin", `${headSha}:refs/heads/${branch}`],
      true,
    );
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
      await this.command(checkout, ["worktree", "list", "--porcelain", "-z"])
    ).split("\0\0");
    const requested = await this.resolvePath(worktree);
    for (const entry of entries) {
      const fields = entry.split("\0");
      const listed = fields.find((field) => field.startsWith("worktree "));
      if (!listed) continue;
      // Unrelated registrations may be unreadable; requested-path errors still propagate above.
      const observed = await this.resolvePath(listed.slice(9)).catch(
        () => undefined,
      );
      if (observed !== requested) continue;
      if (!fields.includes(`branch refs/heads/${branch}`))
        throw new Error(
          "Cleanup Worktree ownership changed; retaining resources",
        );
      await this.command(checkout, [
        "worktree",
        "remove",
        "--",
        listed.slice(9),
      ]);
      break;
    }
    if (head) await this.command(checkout, ["branch", "-D", "--", branch]);
  }

  private async resolvePath(directory: string): Promise<string> {
    try {
      return await realpath(directory);
    } catch (error) {
      const absolute = path.resolve(directory);
      const parent = path.dirname(absolute);
      if (
        (error as NodeJS.ErrnoException).code !== "ENOENT" ||
        parent === absolute
      )
        throw error;
      // Cleanup recovery may find missing descendants below an existing alias.
      return path.join(await this.resolvePath(parent), path.basename(absolute));
    }
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
    const [requested, observed] = await Promise.all([
      this.resolvePath(worktree),
      this.resolvePath(actualPath.trim()),
    ]);
    return {
      // Preserve the saved spelling only after verifying the physical Git root.
      worktree: path.resolve(
        requested === observed ? worktree : actualPath.trim(),
      ),
      branch: branch.trim(),
      base: actualBase.trim(),
      commits,
      clean: status === "",
      changed: diff !== "",
    };
  }
}
