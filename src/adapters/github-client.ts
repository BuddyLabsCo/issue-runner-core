import { execFile } from "node:child_process";

import { formatToolError } from "./process-errors.ts";

export interface GitHubCommandOptions {
  token: string;
  timeout: number;
  allowedExitCodes?: number[];
  input?: string;
}

export type GitHubCommand = (
  args: string[],
  options: GitHubCommandOptions,
) => Promise<string>;

const runGitHubCommand: GitHubCommand = (
  args,
  { token, timeout, allowedExitCodes = [], input },
) =>
  new Promise((resolve, reject) => {
    const child = execFile(
      "gh",
      args,
      {
        encoding: "utf8",
        shell: false,
        env: { ...process.env, GH_TOKEN: token },
        maxBuffer: 10 * 1024 * 1024,
        timeout,
      },
      (error, stdout, stderr) => {
        if (!error) {
          resolve(stdout);
          return;
        }
        if (
          typeof error.code === "number" &&
          allowedExitCodes.includes(error.code) &&
          stdout.trim() !== ""
        ) {
          resolve(stdout);
          return;
        }
        if (
          typeof error.code === "number" &&
          allowedExitCodes.includes(error.code) &&
          /no (?:required )?checks reported/u.test(stderr)
        ) {
          resolve("[]");
          return;
        }
        const detail = (
          stderr.trim() || formatToolError("gh", error)
        ).replaceAll(token, "[redacted]");
        reject(
          new GitHubCommandError(
            `gh command failed: ${detail}`,
            stdout.replaceAll(token, "[redacted]"),
          ),
        );
      },
    );
    if (input !== undefined) {
      child.stdin?.on("error", () => {
        // The process callback reports the command failure.
      });
      child.stdin?.end(input);
    }
  });

export class GitHubCommandError extends Error {
  readonly stdout: string;

  constructor(message: string, stdout: string) {
    super(message);
    this.stdout = stdout;
  }
}

export interface GraphQLResponse {
  data?: unknown;
  errors?: unknown;
  commandError?: GitHubCommandError;
}

export class GitHubClient {
  private readonly token: string;
  private readonly command: GitHubCommand;

  constructor(token: string, command: GitHubCommand = runGitHubCommand) {
    this.token = token;
    this.command = command;
  }

  request(args: string[], allowedExitCodes?: number[]): Promise<string> {
    return this.command(args, {
      token: this.token,
      timeout: 60_000,
      ...(allowedExitCodes ? { allowedExitCodes } : {}),
    });
  }

  async graphql(
    query: string,
    variables: Record<string, unknown>,
  ): Promise<GraphQLResponse> {
    let output: string;
    let commandError: GitHubCommandError | undefined;
    try {
      output = await this.command(["api", "graphql", "--input", "-"], {
        token: this.token,
        timeout: 60_000,
        input: JSON.stringify({ query, variables }),
      });
    } catch (error) {
      if (!(error instanceof GitHubCommandError) || !error.stdout.trim())
        throw error;
      output = error.stdout;
      commandError = error;
    }
    let value: unknown;
    try {
      value = JSON.parse(output);
    } catch (error) {
      throw new AggregateError(
        commandError ? [error, commandError] : [error],
        "GitHub returned invalid GraphQL JSON",
        { cause: error },
      );
    }
    if (
      typeof value !== "object" ||
      value === null ||
      Array.isArray(value) ||
      !("data" in value || "errors" in value)
    ) {
      throw new Error("GitHub returned an invalid GraphQL envelope", {
        cause: commandError,
      });
    }
    return {
      ...(value as { data?: unknown; errors?: unknown }),
      ...(commandError ? { commandError } : {}),
    };
  }
}
