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
) => Promise<string | { stdout: string; error: Error }>;

interface GraphQLResponse {
  data?: Record<string, unknown> | null;
  errors?: unknown[];
  [key: string]: unknown;
}

const commandTimeout = 60_000;

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
        const detail =
          error.killed && error.code === null
            ? `gh command timed out after ${timeout} ms`
            : `gh command failed: ${stderr.trim() || formatToolError("gh", error)}`;
        const failure = new Error(detail.replaceAll(token, "[redacted]"));
        // A failed command can still carry a GraphQL envelope on stdout.
        if (input !== undefined && stdout.trim()) {
          resolve({ stdout, error: failure });
          return;
        }
        reject(failure);
      },
    );
    if (input !== undefined && child.stdin) {
      child.stdin.on("error", () => {
        // gh may exit before consuming stdin. Its exit and output carry the failure.
      });
      child.stdin.end(input);
    }
  });

export class GitHubClient {
  private readonly token: string;
  private readonly command: GitHubCommand;

  constructor(token: string, command: GitHubCommand = runGitHubCommand) {
    this.token = token;
    this.command = command;
  }

  async request(args: string[], allowedExitCodes?: number[]): Promise<string> {
    const result = await this.command(args, {
      token: this.token,
      timeout: commandTimeout,
      ...(allowedExitCodes ? { allowedExitCodes } : {}),
    });
    if (typeof result !== "string") throw result.error;
    return result;
  }

  async graphql(
    query: string,
    variables: Record<string, unknown>,
  ): Promise<{
    response: GraphQLResponse;
    commandError: Error | null;
  }> {
    const result = await this.command(
      ["api", "graphql", "--method", "POST", "--input", "-"],
      {
        token: this.token,
        timeout: commandTimeout,
        input: JSON.stringify({ query, variables }),
      },
    );
    const commandError = typeof result === "string" ? null : result.error;
    const stdout = typeof result === "string" ? result : result.stdout;
    if (!stdout.trim())
      throw new Error("GitHub returned no GraphQL response", {
        cause: commandError,
      });

    let response: unknown;
    try {
      response = JSON.parse(stdout, (_key, value: unknown) =>
        typeof value === "string"
          ? value.replaceAll(this.token, "[redacted]")
          : value,
      ) as unknown;
    } catch {
      throw new Error("GitHub returned invalid GraphQL JSON", {
        cause: commandError,
      });
    }
    if (!isGraphQLResponse(response))
      throw new Error("GitHub returned an invalid GraphQL envelope", {
        cause: commandError,
      });
    return { response, commandError };
  }
}

function isGraphQLResponse(value: unknown): value is GraphQLResponse {
  if (typeof value !== "object" || value === null || Array.isArray(value))
    return false;
  if ("errors" in value && !Array.isArray(value.errors)) return false;
  if ("data" in value)
    return (
      value.data === null ||
      (typeof value.data === "object" && !Array.isArray(value.data))
    );
  return (
    "errors" in value && Array.isArray(value.errors) && value.errors.length > 0
  );
}
