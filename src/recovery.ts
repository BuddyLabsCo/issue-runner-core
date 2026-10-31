import { mkdir, rename, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import path from "node:path";
import type {
  CommitEvidence,
  PullRequestIdentity,
  RequiredCheck,
} from "./run/contracts.ts";

export function hashRunInput(
  argv: readonly string[],
  config: Uint8Array,
): string {
  return createHash("sha256")
    .update(JSON.stringify(argv))
    .update(config)
    .digest("hex");
}

export interface ExecutionResult {
  outcome: "committed" | "no_change";
  summary: string;
  commits: CommitEvidence[];
  findings_file: null;
}

export interface Invocation {
  invocation_id: string;
  path: string;
}

export interface ReviewResult {
  outcome: "passed" | "findings";
  summary: string;
  commits: [];
  findings_file: string | null;
}

export interface StageProgress<R> {
  probe?: { probe_id: string; path: string };
  invocation?: Invocation;
  pendingPrompt?: string;
  result?: R;
  corrections: number;
  probeRetries?: number;
  probeIds?: string[];
  superseded: string[];
}

export interface ReviewProgress extends StageProgress<ReviewResult> {
  round: number;
  base: string;
  head: string;
  findings: string;
  fix?: StageProgress<ExecutionResult>;
}

export interface ImplementationProgress extends StageProgress<ExecutionResult> {
  run_id: string;
  execution_id: string;
  project: string;
  repository: string;
  ticket: number;
  target_branch: string;
  worktree: string;
  branch: string;
  base: string;
  phase:
    | "reserved"
    | "worktree_created"
    | "probing"
    | "implementing"
    | "implementation_completed"
    | "reviewing"
    | "review_completed"
    | "fixing_review"
    | "fix_review_completed"
    | "publication_eligible";
  roles: Partial<Record<"implement" | "review", { sessionid: string }>>;
  pr_title?: string;
  pr_body?: string;
  reviews?: ReviewProgress[];
  publication?: PublicationProgress;
}

export interface PublicationProgress {
  phase:
    | "pending_push"
    | "pushed"
    | "pending_pr"
    | "pr_created"
    | "checks_ready"
    | "checks_failed";
  branch: string;
  targetBranch: string;
  headSha: string;
  title: string;
  body: string;
  commits: CommitEvidence[];
  pullRequest?: PullRequestIdentity;
  creationAttempted?: boolean;
  discoveryNotBefore?: number;
  checksDeadline?: number;
  checks?: RequiredCheck[];
}

export interface BatchProgress {
  run_id: string;
  input_hash: string;
  repository: string;
  target_branch: string;
  tickets: number[];
}

export async function saveProgress(
  file: string,
  progress: ImplementationProgress | BatchProgress,
): Promise<void> {
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(`${file}.tmp`, `${JSON.stringify(progress, null, 2)}\n`);
  await rename(`${file}.tmp`, file);
}
