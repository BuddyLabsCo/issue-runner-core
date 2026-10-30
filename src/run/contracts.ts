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
  resolveTargetBranch(repository: string): Promise<string>;
}

export interface GitWorkspace {
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
  sleep(milliseconds: number): Promise<void>;
}

export interface OperatorIO {
  write(message: string): void;
  pause(message: string): Promise<string | null>;
}

export interface RetryPolicy {
  operationRetry: number;
  agentRetry: number;
  operationRetryDelay: number[];
  agentRetryDelay: number[];
}
