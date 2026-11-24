import { mkdir, rename, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import path from "node:path";
import type {
  CommitEvidence,
  PullRequestIdentity,
  RequiredCheck,
  PullRequestState,
  PullRequestMergeFacts,
} from "./run/contracts.ts";
import type { RunScope } from "./run/scope.ts";

export const checkpointVersion = 1;

export function sameRepositoryName(value: unknown, expected: string): boolean {
  return (
    typeof value === "string" &&
    value.trim().length > 0 &&
    value.toLowerCase() === expected.toLowerCase()
  );
}

export interface NativeSession {
  sessionid: string;
  agent: string;
  resume: string;
}

export function hashRunInput(
  commandName: string,
  argv: readonly string[],
  config: Uint8Array,
): string {
  return createHash("sha256")
    .update(JSON.stringify([commandName, argv]))
    .update(config)
    .digest("hex");
}

export interface ExecutionResult {
  outcome: "committed" | "no_change";
  summary: string;
  commits: CommitEvidence[];
  findings_file: null;
}

export interface PRExecutionResult extends ExecutionResult {
  pr_title: string;
  pr_body: string;
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
  agent?: string;
  resume?: string;
  probe?: { path: string };
  invocation?: Invocation;
  pendingPrompt?: string;
  result?: R;
  superseded: string[];
}

export interface ReviewProgress extends StageProgress<ReviewResult> {
  round: number;
  base: string;
  head: string;
  findings: string;
  fix?: StageProgress<ExecutionResult>;
}

export interface OperationProgress {
  consumed: number;
  error: string;
  notBefore?: number;
}

export interface NoChangeProgress {
  assessment: PRExecutionResult;
  head: string;
  review?: StageProgress<ReviewResult> & { findings: string };
  fix?: StageProgress<PRExecutionResult>;
  delivery?: {
    phase: "pending_comment" | "commented" | "delivered";
    comment: string;
    closure?: { state: "closed"; stateReason: "completed" };
    deliveryLabels?: string[];
  };
}

export interface ReservationIdentity {
  issueId: string;
  repositoryId: string;
  labelId: string;
  runnerId: string;
}

export interface ImplementationProgress extends StageProgress<PRExecutionResult> {
  checkpoint_version: typeof checkpointVersion;
  run_scope?: RunScope;
  operations?: Record<string, OperationProgress>;
  reservation?: ReservationIdentity;
  purpose?: "documentation";
  noChangeClosure?: "pending" | "completed";
  noChange?: NoChangeProgress;
  run_id: string;
  run_arguments: readonly string[];
  input_hash: string;
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
    Record<"implement" | "review" | "documentation", NativeSession>
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
  repositoryId: string;
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
  checksState?: PullRequestMergeFacts;
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
  actionsRerun?: {
    runId: string;
    previousAttempt: number;
    retryable?: true;
    failureAcknowledged?: true;
  };
  checksReconciled?: true;
}

export interface BatchProgress {
  checkpoint_version: typeof checkpointVersion;
  run_scope: RunScope;
  run_id: string;
  run_arguments: readonly string[];
  input_hash: string;
  repository: string;
  target_branch: string;
  tickets: number[];
  completed?: boolean;
  documentation?: string;
}

export interface MaintenanceProgress {
  checkpoint_version?: typeof checkpointVersion;
  run_scope?: RunScope;
  run_id: string;
  run_arguments: readonly string[];
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
