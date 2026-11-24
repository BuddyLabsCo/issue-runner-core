import { execFile, type ExecFileException } from "node:child_process";

import { formatToolError } from "./process-errors.ts";

export interface GitHubCommandOptions {
  timeout: number;
  allowedExitCodes?: number[];
  input?: string;
}

export type GitHubCommand = (
  args: string[],
  options: GitHubCommandOptions,
) => Promise<
  | string
  | { stdout: string; error: Error; exitCode?: ExecFileException["code"] }
>;

interface GraphQLResponse {
  data?: Record<string, unknown> | null;
  errors?: unknown[];
  [key: string]: unknown;
}

const commandTimeout = 60_000;

const runGitHubCommand: GitHubCommand = (
  args,
  { timeout, allowedExitCodes = [], input },
) =>
  new Promise((resolve, reject) => {
    const child = execFile(
      "gh",
      args,
      {
        encoding: "utf8",
        shell: false,
        maxBuffer: 10 * 1024 * 1024,
        timeout,
      },
      (error, stdout, stderr) => {
        // execFile can report exit zero after sending its timeout signal.
        const timedOut = child.killed && typeof error?.code !== "string";
        if (!timedOut && !error) {
          resolve(stdout);
          return;
        }
        if (
          !timedOut &&
          typeof error?.code === "number" &&
          allowedExitCodes.includes(error.code)
        ) {
          if (stdout.trim()) {
            resolve(stdout);
            return;
          }
          if (/no (?:required )?checks reported/u.test(stderr)) {
            resolve("[]");
            return;
          }
        }
        const detail = timedOut
          ? `gh command timed out after ${timeout} ms`
          : `gh command failed: ${stderr.trim() || formatToolError("gh", error)}`;
        const failure = new Error(detail);
        // A failed command can still carry a GraphQL envelope on stdout.
        if (input !== undefined && stdout.trim()) {
          resolve({
            stdout,
            error: failure,
            exitCode: timedOut ? undefined : error?.code,
          });
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
  private readonly command: GitHubCommand;

  constructor(command: GitHubCommand = runGitHubCommand) {
    this.command = command;
  }

  async request(args: string[], allowedExitCodes?: number[]): Promise<string> {
    const result = await this.command(args, {
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
    exitCode?: ExecFileException["code"];
  }> {
    const result = await this.command(
      ["api", "graphql", "--method", "POST", "--input", "-"],
      {
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
      response = JSON.parse(stdout);
    } catch {
      throw new Error("GitHub returned invalid GraphQL JSON", {
        cause: commandError,
      });
    }
    if (!isGraphQLResponse(response))
      throw new Error("GitHub returned an invalid GraphQL envelope", {
        cause: commandError,
      });
    const exitCode = typeof result === "string" ? undefined : result.exitCode;
    return {
      response,
      commandError,
      ...(exitCode === undefined ? {} : { exitCode }),
    };
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
