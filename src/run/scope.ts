import { createHash } from "node:crypto";
import { realpathSync } from "node:fs";
import path from "node:path";
import type { LoadedProject } from "../config.ts";

export const runScopeVersion = 1;

export interface RunScope {
  version: typeof runScopeVersion;
  project: string;
  repository: string;
  checkout: string;
  targetBranch: string;
  selector: { kind: "issue"; ticket?: number; issueList?: number[] };
  review: { enabled: boolean; maxReviewRounds?: number };
}

function canonicalPath(value: string): string {
  try {
    return realpathSync.native(value);
  } catch {
    return path.resolve(value);
  }
}

export function runScope(
  options: { issueTicket?: number },
  loaded: LoadedProject,
  targetBranch: string,
): RunScope {
  const { review, maxReviewRounds } = loaded.config.workflow;
  return {
    version: runScopeVersion,
    project: loaded.directory,
    repository: loaded.config.repository.toLowerCase(),
    checkout: canonicalPath(loaded.config.checkout),
    targetBranch,
    selector:
      options.issueTicket === undefined
        ? { kind: "issue", issueList: loaded.config.issueList }
        : { kind: "issue", ticket: options.issueTicket },
    review: {
      enabled: review,
      ...(review && maxReviewRounds !== undefined ? { maxReviewRounds } : {}),
    },
  };
}

export function runScopeId(scope: RunScope): string {
  return createHash("sha256").update(JSON.stringify(scope)).digest("hex");
}
