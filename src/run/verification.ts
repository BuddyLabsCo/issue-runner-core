import path from "node:path";
import type { ExecutionResult } from "../recovery.ts";
import type { WorkspaceEvidence } from "./contracts.ts";

export function verifyWorkspace<T extends ExecutionResult>(
  expected: {
    worktree: string;
    branch: string;
    base: string;
    targetBase?: string;
  },
  actual: WorkspaceEvidence,
  result: T,
): T {
  if (
    !path.isAbsolute(actual.worktree) ||
    path.resolve(actual.worktree) !== path.resolve(expected.worktree)
  )
    throw new Error(
      `Worktree path mismatch: expected ${expected.worktree}, observed ${actual.worktree}`,
    );
  if (actual.branch !== expected.branch)
    throw new Error(
      `Delivery branch mismatch: expected ${expected.branch}, observed ${actual.branch}`,
    );
  if (actual.base !== expected.base)
    throw new Error(
      `Base SHA mismatch: expected ${expected.base}, observed ${actual.base}`,
    );
  if (!actual.clean) throw new Error("Worktree must be clean");
  const claimed = new Map(result.commits.map((commit) => [commit.sha, commit]));
  if (
    actual.commits.length !== result.commits.length ||
    claimed.size !== result.commits.length
  )
    throw new Error("Claimed commits do not match actual Git commits");
  const commits = actual.commits.map(({ sha }) => {
    const commit = claimed.get(sha);
    if (!commit)
      throw new Error("Claimed commits do not match actual Git commits");
    claimed.delete(sha);
    return commit;
  });
  // Conflict merges can preserve the tree; repair callers verify target ancestry.
  if (
    result.outcome === "committed" &&
    !actual.changed &&
    expected.targetBase === undefined
  )
    throw new Error("Committed implementation has no actual changes");
  return { ...result, commits };
}
