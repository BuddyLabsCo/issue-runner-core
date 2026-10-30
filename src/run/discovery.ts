import path from "node:path";
import type { LoadedProject } from "../config.ts";
import { readHandoff } from "../agent/handoff.ts";
import type { ChildPage, Ticket, Tracker } from "./contracts.ts";
import type { RunContext } from "./run.ts";

export type ReadOperation = <T>(
  operation: string,
  target: string,
  action: () => Promise<T>,
) => Promise<T>;

export async function readChildren(
  repository: string,
  parent: number,
  tracker: Tracker,
  read: ReadOperation,
): Promise<Ticket[]> {
  const children: Ticket[] = [];
  let page: number | null = 1;
  const pages = new Set<number>();
  while (page !== null) {
    if (!Number.isSafeInteger(page) || page <= 0 || pages.has(page))
      throw new Error("invalid child pagination");
    pages.add(page);
    const currentPage: number = page;
    const current: ChildPage = await read(
      "read_children",
      `parent:${parent}:page:${page}`,
      () => tracker.listChildrenPage(repository, parent, currentPage),
    );
    children.push(...current.children);
    page = current.nextPage;
  }
  const foreignChild = children.find(
    (child) => child.repository !== repository,
  );
  if (foreignChild)
    throw new Error(
      `cross-repository child ${foreignChild.repository}#${foreignChild.number} is unsupported`,
    );
  return children;
}

export async function hasOpenBlocker(
  repository: string,
  number: number,
  tracker: Tracker,
  read: ReadOperation,
): Promise<boolean> {
  let blocked = false;
  let page: number | null = 1;
  const pages = new Set<number>();
  while (page !== null) {
    if (!Number.isSafeInteger(page) || page <= 0 || pages.has(page))
      throw new Error("invalid blocker pagination");
    pages.add(page);
    const currentPage: number = page;
    const current: Awaited<ReturnType<Tracker["listBlockersPage"]>> =
      await read("read_blockers", `ticket:${number}:page:${page}`, () =>
        tracker.listBlockersPage(repository, number, currentPage),
      );
    for (const blocker of current.blockers) {
      if (blocker.state === "closed" && blocker.stateReason === null)
        throw new Error(
          `blocker ${blocker.number} has an unsupported terminal state`,
        );
      if (blocker.state === "open") blocked = true;
    }
    page = current.nextPage;
  }
  return blocked;
}

export async function selectIssueBatch(input: {
  tickets: Ticket[];
  loaded: LoadedProject;
  tracker: Tracker;
  context: RunContext;
  read: ReadOperation;
}): Promise<{ batch: Ticket[]; reasons: string[] }> {
  const { tickets, loaded, tracker, context, read } = input;
  const config = loaded.config;
  const eligible: Ticket[] = [];
  const blocked: number[] = [];
  const externallyOwned: number[] = [];
  const reservations: string[] = [];
  for (const child of [...tickets].sort((a, b) => a.number - b.number)) {
    const isBlocked = await hasOpenBlocker(
      config.repository,
      child.number,
      tracker,
      read,
    );
    if (child.state === "closed") {
      if (child.stateReason === null)
        throw new Error(
          `Delivery Ticket ${child.number} has an unsupported terminal state`,
        );
      continue;
    }
    const hasRunner =
      child.assignees?.includes(config.tracker.runnerAccount) ?? false;
    const hasLabel =
      child.labels?.includes(config.tracker.reservationLabel) ?? false;
    const external = child.assignees?.some(
      (account) => account !== config.tracker.runnerAccount,
    );
    if (external) externallyOwned.push(child.number);
    if (isBlocked) blocked.push(child.number);
    if (hasRunner || hasLabel)
      reservations.push(
        `${child.number} (${hasRunner && hasLabel ? "complete" : "partial"})`,
      );
    if (
      external ||
      isBlocked ||
      !child.labels?.includes("ready-for-agent") ||
      (config.issueList.length > 0 &&
        !config.issueList.includes(child.number)) ||
      hasRunner !== hasLabel
    )
      continue;
    if (
      hasRunner &&
      !(await readHandoff(
        path.join(
          loaded.directory,
          "recovery",
          `${context.inputHash}-${child.number}.json`,
        ),
      ))
    )
      continue;
    eligible.push(child);
  }
  const missing = config.issueList.filter(
    (number) => !tickets.some((child) => child.number === number),
  );
  return {
    batch: eligible.slice(0, config.maxBatchSize),
    reasons: [
      ...(blocked.length
        ? [`blocked Delivery Tickets: ${blocked.join(", ")}`]
        : []),
      ...(externallyOwned.length
        ? [`externally owned Delivery Tickets: ${externallyOwned.join(", ")}`]
        : []),
      ...(reservations.length
        ? [`existing Reservations: ${reservations.join(", ")}`]
        : []),
      ...(missing.length
        ? [`configured Delivery Tickets not found: ${missing.join(", ")}`]
        : []),
    ],
  };
}
