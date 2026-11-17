import type { ConfirmationStatus } from "./confirmations.ts";

// Source workflow boundaries, extracted as needed by the supported Run slice.
export interface Ticket {
  number: number;
  id?: string;
  repositoryId?: string;
  labelIds?: Record<string, string>;
  assigneeIds?: Record<string, string>;
  state: "open" | "closed";
  stateReason: "completed" | "not_planned" | null;
  repository?: string;
  title?: string;
  body?: string;
  source?: string;
  assignees?: string[];
  labels?: string[];
  blockers?: Ticket[];
}

export interface ChildPage {
  children: Ticket[];
  nextPage: number | null;
}

export interface Tracker {
  observeStart(input: {
    repository: string;
    number: number;
    parent?: number;
    runner: string;
    label: string;
  }): Promise<{
    ticket: Ticket & { id: string };
    parent?: Ticket;
    children?: Ticket[];
    labelId?: string;
    runnerId?: string;
  }>;
  reserveStart(input: {
    ticket: Ticket & { id: string };
    labelId?: string;
    runnerId?: string;
    label: string;
    runner: string;
  }): Promise<Ticket>;
  observeParent(
    repository: string,
    parentTicket: number,
  ): Promise<{ parent: Ticket; tickets: Ticket[] }>;
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
  observeDelivery(repository: string, ticket: number): Promise<Ticket>;
  listBlockersPage(
    repository: string,
    ticket: number,
    page: number,
  ): Promise<{ blockers: Ticket[]; nextPage: number | null }>;
  addLabel(repository: string, ticket: number, label: string): Promise<void>;
  addAssignee(
    repository: string,
    ticket: number,
    account: string,
  ): Promise<void>;
  getParent(repository: string, parentTicket: number): Promise<Ticket>;
  listChildrenPage(
    repository: string,
    parentTicket: number,
    page: number,
  ): Promise<ChildPage>;
}

export interface CodeHost {
  getPullRequest(
    repository: string,
    pullRequest: number,
  ): Promise<PullRequestState>;
  requestSquashMerge(input: {
    repository: string;
    pullRequest: number;
    headSha: string;
    admin: boolean;
  }): Promise<MergeRequestResult>;
  resolveTargetBranch(repository: string): Promise<string>;
  getRemoteBranchHead(
    repository: string,
    branch: string,
  ): Promise<string | null>;
  listPullRequests(repository: string): Promise<PublicationPullRequest[]>;
  observePublicationBranch(
    repository: string,
    branch: string,
  ): Promise<{ repositoryId: string; head: string | null }>;
  observePublication(input: {
    repository: string;
    branch: string;
    targetBranch: string;
  }): Promise<PublicationObservation>;
  createPullRequest(input: {
    repositoryId: string;
    repository: string;
    targetBranch: string;
    branch: string;
    title: string;
    body: string;
  }): Promise<PublicationPullRequest>;
  getRequiredChecks(
    repository: string,
    pullRequest: number,
  ): Promise<RequiredCheck[]>;
}

export interface PullRequestState {
  headSha: string;
  createdAt: string;
  merged: boolean;
  mergeRequested: boolean;
  mergeable: "mergeable" | "conflicting" | "unknown";
  mergeFailure: string | null;
}

export type MergeRequestResult =
  | { outcome: "accepted" }
  | { outcome: "conflict" | "rejected"; error: unknown };

export interface PullRequestIdentity {
  number: number;
  url: string;
}

export interface PullRequestRecord extends PullRequestIdentity {
  branch: string;
  targetBranch: string;
  headSha: string;
  state: "open" | "closed" | "merged";
  draft?: boolean;
}

export interface PublicationPullRequest extends PullRequestRecord {
  id: string;
  createdAt: string;
  draft: boolean;
}

export interface PublicationObservation {
  repositoryId: string;
  head: string | null;
  candidates: PublicationPullRequest[];
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
