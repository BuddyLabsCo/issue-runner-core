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
            `gh command ${error.killed && error.signal === "SIGTERM" && error.code === null ? "timed out" : "failed"}: ${detail}`,
            stdout.replaceAll(token, "[redacted]"),
          ),
        );
      },
    );
    if (input !== undefined) {
      child.stdin?.on("error", () => {
        // The process callback reports failures when gh closes stdin early.
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

export interface GitHubGraphQLResponse {
  data?: unknown;
  errors?: unknown;
}

export class GitHubGraphQLError extends Error {
  readonly response: GitHubGraphQLResponse | undefined;

  constructor(
    message: string,
    response: GitHubGraphQLResponse | undefined,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.response = response;
  }
}

export class GitHubClient {
  private readonly token: string;
  private readonly command: GitHubCommand;

  constructor(token: string, command: GitHubCommand = runGitHubCommand) {
    this.token = token;
    this.command = command;
  }

  async graphql(
    query: string,
    variables: Record<string, unknown>,
  ): Promise<GitHubGraphQLResponse> {
    let output: string;
    let failure: GitHubCommandError | undefined;
    try {
      output = await this.command(["api", "graphql", "--input", "-"], {
        token: this.token,
        timeout: 60_000,
        input: JSON.stringify({ query, variables }),
      });
    } catch (error) {
      if (!(error instanceof GitHubCommandError)) throw error;
      output = error.stdout;
      failure = error;
    }
    let response: unknown;
    try {
      response = JSON.parse(output) as unknown;
    } catch (error) {
      throw new GitHubGraphQLError(
        `${output.trim() ? "GitHub returned invalid GraphQL JSON" : "GitHub returned no GraphQL payload"}${failure ? `: ${failure.message}` : ""}`,
        undefined,
        { cause: failure ?? error },
      );
    }
    if (
      typeof response !== "object" ||
      response === null ||
      Array.isArray(response)
    )
      throw new GitHubGraphQLError(
        `GitHub returned invalid GraphQL payload${failure ? `: ${failure.message}` : ""}`,
        undefined,
        { cause: failure },
      );
    const result = response as GitHubGraphQLResponse;
    if (failure)
      throw new GitHubGraphQLError(
        `GitHub GraphQL command failed: ${failure.message}`,
        result,
        {
          cause: failure,
        },
      );
    if (!("data" in result) && !("errors" in result))
      throw new GitHubGraphQLError(
        "GitHub returned no GraphQL data or errors",
        result,
      );
    return result;
  }

  request(args: string[], allowedExitCodes?: number[]): Promise<string> {
    return this.command(args, {
      token: this.token,
      timeout: 60_000,
      ...(allowedExitCodes ? { allowedExitCodes } : {}),
    });
  }
}
