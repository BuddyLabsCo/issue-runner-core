import type { ConfirmationStatus } from "./confirmations.ts";

// Source workflow boundaries, extracted as needed by the supported Run slice.
export interface Ticket {
  number: number;
  state: "open" | "closed";
  stateReason: "completed" | "not_planned" | null;
  repository?: string;
  title?: string;
  body?: string;
  source?: string;
  assignees?: string[];
  labels?: string[];
}

export interface ChildPage {
  children: Ticket[];
  nextPage: number | null;
}

export interface IssueFact extends Pick<
  Ticket,
  "number" | "state" | "stateReason"
> {
  id: string;
  repository: string;
  repositoryId: string;
}

interface IssueLabel {
  id: string;
  name: string;
}

interface IssueAssignee {
  id: string;
  login: string;
}

export interface ReservationMarkers {
  labels: IssueLabel[];
  assignees: IssueAssignee[];
}

export interface ParentDiscoveryChild extends IssueFact, ReservationMarkers {
  blockers: IssueFact[];
}

interface MarkerLookup {
  reservation: IssueLabel | null;
  runner: IssueAssignee | null;
}

interface IssueStartScope {
  parent: IssueFact;
  children: IssueFact[];
}

export interface ParentDiscovery extends MarkerLookup {
  parent: IssueFact;
  children: ParentDiscoveryChild[];
}

export interface IssueStartFacts extends MarkerLookup {
  issue: ParentDiscoveryChild & Pick<Ticket, "title" | "body" | "source">;
  scope?: IssueStartScope;
}

export interface ReservationAdditions {
  issue: IssueFact;
  reservation: IssueLabel;
  runner: IssueAssignee;
  addLabel: boolean;
  addRunner: boolean;
}

export interface Tracker {
  createLabel(repository: string, label: string): Promise<void>;
  listLabelsPage(
    repository: string,
    page: number,
  ): Promise<{ labels: string[]; nextPage: number | null }>;
  createMaintenanceTicket(
    repository: string,
    title: string,
    body: string,
    label: string,
  ): Promise<Ticket>;
  closeTicket(repository: string, ticket: number): Promise<void>;
  commentTicket(
    repository: string,
    ticket: number,
    body: string,
  ): Promise<void>;
  getTicket(repository: string, ticket: number): Promise<Ticket>;
  listBlockersPage(
    repository: string,
    ticket: number,
    page: number,
  ): Promise<{ blockers: Ticket[]; nextPage: number | null }>;
  readIssueStart(
    repository: string,
    ticket: number,
    markers: { reservationLabel: string; runnerAccount: string },
    parentTicket?: number,
    signal?: AbortSignal,
  ): Promise<IssueStartFacts>;
  reserveIssue(
    additions: ReservationAdditions,
    signal?: AbortSignal,
  ): Promise<ReservationMarkers>;
  getParent(repository: string, parentTicket: number): Promise<Ticket>;
  discoverParent(
    repository: string,
    parentTicket: number,
    markers: { reservationLabel: string; runnerAccount: string },
    signal?: AbortSignal,
  ): Promise<ParentDiscovery>;
  listChildrenPage(
    repository: string,
    parentTicket: number,
    page: number,
  ): Promise<ChildPage>;
}

export interface CodeHost {
  requestSquashMerge(input: {
    pullRequest: PullRequestIdentity;
    headSha: string;
    autoMerge: boolean;
  }): Promise<MergeRequestResult>;
  observeDelivery(
    input: { repository: string; number: number; ticket: number },
    signal?: AbortSignal,
  ): Promise<DeliveryObservation>;
  resolveTargetBranch(repository: string): Promise<string>;
  observeBranch(repository: string, branch: string): Promise<BranchObservation>;
  observePublication(
    input: PublicationQuery,
    signal?: AbortSignal,
  ): Promise<PublicationObservation>;
  createPullRequest(
    input: PublicationQuery & {
      repositoryId: string;
      title: string;
      body: string;
    },
  ): Promise<PullRequestRecord>;
  observePullRequest(
    input: PullRequestQuery,
    signal?: AbortSignal,
  ): Promise<PullRequestObservation>;
}

export interface PullRequestState {
  headSha: string;
  createdAt: string;
  merged: boolean;
  mergeRequested: boolean;
  mergeable: "mergeable" | "conflicting" | "unknown";
  mergeFailure: string | null;
}

export interface PullRequestMergeFacts extends PullRequestState {
  mergeStateStatus: string;
  isInMergeQueue: boolean;
  isMergeQueueEnabled: boolean;
  autoMergeEnabledAt: string | null;
  mergeQueueEntryId: string | null;
}

export type MergeRequestResult =
  | { outcome: "accepted" }
  | { outcome: "conflict" | "rejected"; error: unknown };

export interface PullRequestIdentity {
  id: string;
  number: number;
  url: string;
  createdAt: string;
}

export interface PullRequestRecord extends PullRequestIdentity {
  branch: string;
  targetBranch: string;
  headSha: string;
  state: "open" | "closed" | "merged";
  draft: boolean;
}

export interface BranchObservation {
  repositoryId: string;
  headSha: string | null;
}

export interface PublicationQuery {
  repository: string;
  branch: string;
  targetBranch: string;
}

export interface PublicationObservation extends BranchObservation {
  candidates: PullRequestRecord[];
}

export interface PullRequestQuery {
  repository: string;
  branch: string;
  number: number;
}

export interface PullRequestObservation {
  branch: BranchObservation;
  pullRequest: PullRequestRecord;
  lastCommitSha: string;
  merge: PullRequestMergeFacts;
  checks: RequiredCheck[];
}

export interface DeliveryObservation {
  repositoryId: string;
  defaultBranch: string;
  pullRequest: PullRequestRecord;
  merge: PullRequestMergeFacts;
  issue: IssueFact & { labels: string[] };
}

export interface RequiredCheck {
  name: string;
  state: string;
  link: string;
  bucket: "pass" | "fail" | "pending" | "skipping" | "cancel";
}

export interface GitWorkspace {
  cleanupWorktree(input: {
    checkout: string;
    worktree: string;
    branch: string;
    headSha: string;
  }): Promise<void>;
  push(worktree: string, branch: string, headSha: string): Promise<void>;
  withAgentEnvironment<T>(
    directory: string,
    action: (env: Readonly<Record<string, string>>) => Promise<T>,
  ): Promise<T>;
  fetchTargetBranch(checkout: string, targetBranch: string): Promise<string>;
  createWorktree(input: {
    checkout: string;
    worktree: string;
    branch: string;
    base: string;
  }): Promise<void>;
  inspect(input: {
    worktree: string;
    base: string;
  }): Promise<WorkspaceEvidence>;
}

export interface CommitEvidence {
  sha: string;
  message: string;
}

export interface WorkspaceEvidence {
  worktree: string;
  branch: string;
  base: string;
  commits: CommitEvidence[];
  clean: boolean;
  changed: boolean;
}

export interface Clock {
  now(): Date;
  sleep(milliseconds: number, signal?: AbortSignal): Promise<void>;
}

export interface OperatorIO {
  skipScope?: string;
  intervene?(): () => void;
  write(message: string): void;
  confirmationStatus?(status: ConfirmationStatus): void;
  // Close active input when the supplied signal is cancelled.
  pause(
    message: string,
    signal?: AbortSignal,
    identity?: string,
  ): Promise<string | null>;
}

export interface RetryPolicy {
  operationRetry: number;
  operationRetryDelay: number[];
}
