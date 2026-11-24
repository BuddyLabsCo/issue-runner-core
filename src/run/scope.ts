import { createHash } from "node:crypto";
import path from "node:path";
import type { LoadedProject } from "../config.ts";
import type { RunOptions } from "./run.ts";

export const runScopeVersion = 1;

export interface RunScope {
  version: typeof runScopeVersion;
  project: string;
  repository: string;
  checkout: string;
  targetBranch: string;
  selector:
    | { kind: "parent"; ticket: number; issueList?: number[] }
    | { kind: "issue"; ticket?: number; issueList?: number[] }
    | { kind: "document" };
  review?: { enabled: boolean; maxReviewRounds?: number };
}

export function runScope(
  options: RunOptions,
  loaded: LoadedProject,
  targetBranch: string,
): RunScope {
  const issueList = loaded.config.issueList;
  const selector: RunScope["selector"] =
    options.selector === "parent"
      ? {
          kind: "parent",
          ticket: options.parentTicket!,
          ...(issueList.length === 0 ? {} : { issueList }),
        }
      : options.selector === "document"
        ? { kind: "document" }
        : options.issueTicket === undefined
          ? { kind: "issue", issueList }
          : { kind: "issue", ticket: options.issueTicket };
  const { review, maxReviewRounds } = loaded.config.workflow;
  return {
    version: runScopeVersion,
    project: loaded.directory,
    repository: loaded.config.repository.toLowerCase(),
    checkout: path.resolve(loaded.config.checkout),
    targetBranch,
    selector,
    ...(selector.kind === "document"
      ? {}
      : {
          review: {
            enabled: review,
            ...(review && maxReviewRounds !== undefined
              ? { maxReviewRounds }
              : {}),
          },
        }),
  };
}

export function runScopeId(scope: RunScope): string {
  return createHash("sha256").update(JSON.stringify(scope)).digest("hex");
}
