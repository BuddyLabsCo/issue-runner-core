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
  getTicket(repository: string, ticket: number): Promise<Ticket>;
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
  listPullRequests(repository: string): Promise<PullRequestRecord[]>;
  createPullRequest(input: {
    repository: string;
    targetBranch: string;
    branch: string;
    title: string;
    body: string;
  }): Promise<PullRequestIdentity>;
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
  // Close active input when the supplied Run signal is cancelled.
  pause(message: string, signal?: AbortSignal): Promise<string | null>;
}

export interface RetryPolicy {
  operationRetry: number;
  agentRetry: number;
  operationRetryDelay: number[];
  agentRetryDelay: number[];
}
