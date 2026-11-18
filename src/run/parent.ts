import type { ParentDiscovery, Ticket, Tracker } from "./contracts.ts";
import {
  hasOpenBlocker,
  readChildren,
  validateChildRepositories,
  type BatchTicket,
  type ReadOperation,
} from "./discovery.ts";
import { OperationStopped, OperatorCancelled } from "./operations.ts";
import type { RunSummary } from "./run.ts";

interface ParentScope {
  repository: string;
  parentTicket: number;
  tracker: Tracker;
  read: ReadOperation;
}

function validateParent(parent: Ticket): void {
  if (parent.state === "closed" && parent.stateReason === "not_planned")
    throw new OperatorCancelled("Parent Ticket is cancelled");
  if (parent.state === "closed" && parent.stateReason === null)
    throw new OperationStopped(
      "closed Parent Ticket has no supported closure reason",
    );
}

function validateChildren(
  parent: Ticket,
  tickets: Pick<Ticket, "number" | "state" | "stateReason">[],
): void {
  if (
    parent.state === "closed" &&
    tickets.some((ticket) => ticket.state === "open")
  )
    throw new OperationStopped("completed Parent Ticket has open children");
  for (const ticket of tickets)
    if (ticket.state === "closed" && ticket.stateReason === null)
      throw new OperationStopped(
        `Delivery Ticket ${ticket.number} has an unsupported terminal state`,
      );
}

function closeParent(input: ParentScope): Promise<boolean> {
  const { repository, parentTicket, tracker, read } = input;
  const inspect = async () => {
    const parent = await read("read_parent", `parent:${parentTicket}`, () =>
      tracker.getParent(repository, parentTicket),
    );
    validateParent(parent);
    const tickets = await readChildren(repository, parentTicket, tracker, read);
    validateChildren(parent, tickets);
    for (const ticket of tickets)
      await hasOpenBlocker(repository, ticket.number, tracker, read);
    return { parent, tickets };
  };
  return read(
    "close_parent",
    `parent:${parentTicket}`,
    async () => {
      const scope = await inspect();
      if (scope.parent.state === "closed") return true;
      if (scope.tickets.some((ticket) => ticket.state === "open")) return false;
      await tracker.closeTicket(repository, parentTicket);
      if ((await inspect()).parent.state !== "closed")
        throw new Error("Parent closure has not been confirmed");
      return true;
    },
    {
      reconcile: async () =>
        (await inspect()).parent.state === "closed"
          ? { outcome: "completed", result: true }
          : { outcome: "pending" },
    },
  );
}

function parentBatchTickets(
  children: ParentDiscovery["children"],
): BatchTicket[] {
  return children.map(({ labels, assignees, blockers, ...ticket }) => ({
    ...ticket,
    labels: labels.map((label) => label.name),
    assignees: assignees.map((assignee) => assignee.login),
    blocked: blockers.some((blocker) => blocker.state === "open"),
  }));
}

interface ParentRun extends ParentScope {
  summary: RunSummary;
  markers: Parameters<Tracker["discoverParent"]>[2];
  signal: AbortSignal;
  eligibleIssues: (tickets: BatchTicket[]) => Promise<number[]>;
  runBatch: (tickets: BatchTicket[], eligible: number[]) => Promise<RunSummary>;
  maintenancePending: () => boolean;
}

function discoverBatch(input: ParentRun, select: boolean) {
  const { read, repository, parentTicket, tracker, markers } = input;
  return read("discover_parent", `parent:${parentTicket}`, async () => {
    const { parent, children, reservation, runner } =
      await tracker.discoverParent(
        repository,
        parentTicket,
        markers,
        input.signal,
      );
    validateParent(parent);
    validateChildRepositories(repository, children, parent.repositoryId);
    validateChildren(parent, children);
    const tickets = parentBatchTickets(children);
    const eligible =
      select && parent.state === "open"
        ? await input.eligibleIssues(tickets)
        : [];
    if (eligible.length && !(reservation && runner))
      throw new Error(
        "GitHub did not resolve the configured Reservation label or Runner account",
      );
    return { parent, tickets, eligible };
  });
}

export async function runParent(input: ParentRun): Promise<RunSummary> {
  let hadChildren = false;
  let selectBatch = true;
  for (;;) {
    if (input.maintenancePending())
      return { ...input.summary, outcome: "incomplete" };
    const { parent, tickets, eligible } = await discoverBatch(
      input,
      selectBatch,
    );
    hadChildren ||= tickets.length > 0;
    if (parent.state === "closed")
      return {
        ...input.summary,
        outcome: "succeeded",
      };
    if (!hadChildren) return input.runBatch(tickets, eligible);
    if (tickets.every((ticket) => ticket.state === "closed")) {
      if (await closeParent(input))
        return {
          ...input.summary,
          outcome: "succeeded",
        };
      continue;
    }
    if (!selectBatch) return { ...input.summary, outcome: "incomplete" };
    selectBatch =
      (await input.runBatch(tickets, eligible)).outcome === "succeeded";
  }
}
