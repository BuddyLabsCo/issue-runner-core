import { mkdir, rename, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import path from "node:path";
import type {
  CommitEvidence,
  PullRequestIdentity,
  RequiredCheck,
  PullRequestState,
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
  sessionid?: string;
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
  purpose?: "documentation";
  noChangeClosure?: "pending" | "completed";
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
    | "documenting"
    | "documentation_completed"
    | "reviewing"
    | "review_completed"
    | "fixing_review"
    | "fix_review_completed"
    | "repairing_ci"
    | "ci_repair_completed"
    | "repairing_conflict"
    | "conflict_repair_completed"
    | "publication_eligible";
  roles: Partial<
    Record<"implement" | "review" | "documentation", { sessionid: string }>
  >;
  pr_title?: string;
  pr_body?: string;
  reviews?: ReviewProgress[];
  publication?: PublicationProgress;
  cleanup?: { worktrees: string[]; files: string[] };
}

export interface PublicationProgress {
  phase:
    | "pending_push"
    | "pushed"
    | "pending_pr"
    | "pr_created"
    | "checks_ready"
    | "checks_failed"
    | "conflict_repair"
    | "pending_merge"
    | "merge_requested"
    | "merged"
    | "delivered";
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
  mergeDeadline?: number;
  merge?: PullRequestState;
  closure?: { state: "closed"; stateReason: "completed" };
  deliveryLabels?: string[];
  conflict?: string;
  ciRepair?: RepairBudget;
  conflictRepair?: RepairBudget;
}

export interface RepairBudget {
  consumed: number;
  generation: number;
  retryAuthorized?: boolean;
  attempts: RepairProgress[];
}

export interface RepairProgress extends StageProgress<ExecutionResult> {
  attempt_id: string;
  generation: number;
  worktree: string;
  branch: string;
  base: string;
  failedChecks: RequiredCheck[];
  targetBase?: string;
  conflict?: string;
  worktreeCreated?: boolean;
  counted?: boolean;
  verificationError?: string;
  pendingPush?: string;
  pushed?: boolean;
}

export interface BatchProgress {
  run_id: string;
  input_hash: string;
  repository: string;
  target_branch: string;
  tickets: number[];
  completed?: boolean;
  documentation?: string;
}

export interface MaintenanceProgress {
  run_id: string;
  input_hash: string;
  repository: string;
  target_branch: string;
  phase: "scheduled" | "ticket_created" | "delivered" | "completed" | "skipped";
  creationAttempted?: boolean;
  ticket?: number;
  batch?: string;
}

export async function saveProgress(
  file: string,
  progress: ImplementationProgress | BatchProgress | MaintenanceProgress,
): Promise<void> {
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(`${file}.tmp`, `${JSON.stringify(progress, null, 2)}\n`);
  await rename(`${file}.tmp`, file);
}
