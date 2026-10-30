import { createHash } from "node:crypto";
import { lstat, readFile } from "node:fs/promises";
import type { ExecutionResult } from "../recovery.ts";

export function object(value: unknown): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value))
    throw new Error("Expected a JSON object");
  return value as Record<string, unknown>;
}

export function nonempty(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

export async function readHandoff(
  file: string,
): Promise<{ text: string; revision: string } | undefined> {
  try {
    const info = await lstat(file, { bigint: true });
    if (!info.isFile()) throw new Error("Handoff must be a regular file");
    const text = await readFile(file, "utf8");
    return {
      text,
      // Metadata can collide or describe the file before a concurrent replacement.
      revision: `${info.dev}:${info.ino}:${info.size}:${info.mtimeNs}:${info.ctimeNs}:${createHash("sha256").update(text).digest("hex")}`,
    };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
}

export function parseExecution(text: string): ExecutionResult {
  const value = object(JSON.parse(text) as unknown);
  if (
    Object.keys(value).sort().join(",") !==
    "commits,findings_file,outcome,summary"
  )
    throw new Error(
      "Execution handoff requires exactly outcome, summary, commits, findings_file",
    );
  if (value.outcome !== "committed" && value.outcome !== "no_change")
    throw new Error("Invalid implementation outcome");
  if (!nonempty(value.summary))
    throw new Error("Execution summary must be a nonempty string");
  if (value.findings_file !== null)
    throw new Error("Execution findings_file must be null");
  if (!Array.isArray(value.commits))
    throw new Error("Execution commits must be an array");
  const commits = value.commits.map((entry: unknown) => {
    const commit = object(entry);
    if (
      Object.keys(commit).sort().join(",") !== "message,sha" ||
      typeof commit.sha !== "string" ||
      !/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/u.test(commit.sha) ||
      !nonempty(commit.message)
    )
      throw new Error("Invalid full-SHA/message commit evidence");
    return { sha: commit.sha, message: commit.message };
  });
  if ((value.outcome === "committed") !== commits.length > 0)
    throw new Error("committed requires commits; no_change requires none");
  if (new Set(commits.map((commit) => commit.sha)).size !== commits.length)
    throw new Error("Duplicate claimed commits");
  return {
    outcome: value.outcome,
    summary: value.summary,
    commits,
    findings_file: null,
  };
}
