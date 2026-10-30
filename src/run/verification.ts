import path from "node:path";
import type { ExecutionResult } from "../recovery.ts";
import type { WorkspaceEvidence } from "./contracts.ts";

export function verifyWorkspace(
  expected: { worktree: string; branch: string; base: string },
  actual: WorkspaceEvidence,
  result: ExecutionResult,
): void {
  if (
    !path.isAbsolute(actual.worktree) ||
    path.resolve(actual.worktree) !== path.resolve(expected.worktree) ||
    actual.branch !== expected.branch ||
    actual.base !== expected.base ||
    !actual.clean
  )
    throw new Error(
      "Worktree, branch, base, or clean-state verification failed",
    );
  if (
    actual.commits.length !== result.commits.length ||
    actual.commits.some(
      (commit, index) =>
        commit.sha !== result.commits[index]?.sha ||
        commit.message !== result.commits[index]?.message,
    )
  )
    throw new Error("Claimed commits do not match actual Git commits");
  if (result.outcome === "committed" && !actual.changed)
    throw new Error("Committed implementation has no actual changes");
}
