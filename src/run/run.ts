import type { LoadedProject } from "../config.ts";
import type {
  Tracker,
  CodeHost,
  Clock,
  OperatorIO,
  ChildPage,
} from "./contracts.ts";
import type { AuditLog } from "../audit.ts";
import { externalRead } from "./operations.ts";

export interface RunSummary {
  outcome: "succeeded" | "no_work" | "incomplete" | "cancelled" | "failed";
  project: string;
  parentTicket: number;
  targetBranch: string;
  reasons: string[];
}

export interface RunOptions {
  project: string;
  environment: string;
  selector: "parent" | "issue" | "document";
  parentTicket?: number;
  issueTicket?: number;
  autoMerge: boolean;
}

export async function runProject(
  options: RunOptions,
  loaded: LoadedProject,
  tracker: Tracker,
  codeHost: CodeHost,
  context: {
    audit: AuditLog;
    runId: string;
    clock: Clock;
    operator: OperatorIO;
    signal?: AbortSignal;
  },
): Promise<RunSummary> {
  const read = <T>(
    operation: string,
    target: string,
    action: () => Promise<T>,
  ) =>
    externalRead({
      ...context,
      action,
      retryPolicy: loaded.config,
      event: (attempt) => ({
        timestamp: context.clock.now().toISOString(),
        runId: context.runId,
        project: options.project,
        parentTicket: options.parentTicket ?? 0,
        phase: "discover",
        operation,
        target,
        attempt,
      }),
    });
  context.signal?.throwIfAborted();
  const targetBranch =
    loaded.config.targetBranch ??
    (await read("resolve_target_branch", loaded.config.repository, () =>
      codeHost.resolveTargetBranch(loaded.config.repository),
    ));
  if (!targetBranch.trim()) throw new Error("Target Branch must not be empty");
  const summary: RunSummary = {
    outcome: "incomplete",
    project: options.project,
    parentTicket: options.parentTicket ?? options.issueTicket ?? 0,
    targetBranch,
    reasons: [],
  };
  if (options.selector !== "parent") {
    return {
      ...summary,
      reasons: [`${options.selector} delivery is not implemented yet`],
    };
  }
  const parent = await read(
    "read_parent",
    `parent:${summary.parentTicket}`,
    () => tracker.getParent(loaded.config.repository, summary.parentTicket),
  );
  if (parent.state === "closed" && parent.stateReason === "not_planned")
    return {
      ...summary,
      outcome: "cancelled",
      reasons: ["Parent Ticket is cancelled"],
    };
  if (parent.state === "closed" && parent.stateReason === null)
    throw new Error("closed Parent Ticket has no supported closure reason");
  const children = [];
  let page: number | null = 1;
  const pages = new Set<number>();
  while (page !== null) {
    if (!Number.isSafeInteger(page) || page <= 0 || pages.has(page))
      throw new Error("invalid child pagination");
    pages.add(page);
    const currentPage: number = page;
    const current: ChildPage = await read(
      "read_children",
      `parent:${summary.parentTicket}:page:${page}`,
      () =>
        tracker.listChildrenPage(
          loaded.config.repository,
          summary.parentTicket,
          currentPage,
        ),
    );
    children.push(...current.children);
    page = current.nextPage;
  }
  const foreignChild = children.find(
    (child) => child.repository !== loaded.config.repository,
  );
  if (foreignChild)
    throw new Error(
      `cross-repository child ${foreignChild.repository}#${foreignChild.number} is unsupported`,
    );
  if (parent.state === "closed") {
    if (children.some((child) => child.state === "open"))
      throw new Error("completed Parent Ticket has open children");
    return { ...summary, outcome: "succeeded" };
  }
  if (children.length > 0)
    return {
      ...summary,
      reasons: ["Nonempty parent delivery is not implemented yet"],
    };
  return {
    ...summary,
    outcome: "no_work",
    reasons: loaded.config.issueList.length
      ? [
          `configured Delivery Tickets not found: ${loaded.config.issueList.join(", ")}`,
        ]
      : [],
  };
}
