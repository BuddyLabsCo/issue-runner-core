import type { Ticket, Tracker } from "./contracts.ts";
import {
  hasOpenBlocker,
  readChildren,
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

export async function runParent(
  input: ParentScope & {
    summary: RunSummary;
    markers: Parameters<Tracker["discoverParent"]>[2];
    runBatch: (tickets: BatchTicket[]) => Promise<RunSummary>;
    maintenancePending: () => boolean;
  },
): Promise<RunSummary> {
  const { read, repository, parentTicket, tracker, markers } = input;
  let hadChildren = false;
  let previous: RunSummary | undefined;
  for (;;) {
    if (input.maintenancePending())
      return { ...input.summary, outcome: "incomplete" };
    const { parent, children } = await read(
      "discover_parent",
      `parent:${parentTicket}`,
      () => tracker.discoverParent(repository, parentTicket, markers),
    );
    validateParent(parent);
    validateChildren(parent, children);
    hadChildren ||= children.length > 0;
    if (parent.state === "closed")
      return {
        ...input.summary,
        outcome: "succeeded",
      };
    if (!hadChildren) return input.runBatch([]);
    if (children.every((ticket) => ticket.state === "closed")) {
      if (await closeParent(input))
        return {
          ...input.summary,
          outcome: "succeeded",
        };
      continue;
    }
    if (previous && previous.outcome !== "succeeded")
      return { ...input.summary, outcome: "incomplete" };
    previous = await input.runBatch(
      children.map(({ labels, assignees, blockers, ...ticket }) => ({
        ...ticket,
        labels: labels.map((label) => label.name),
        assignees: assignees.map((assignee) => assignee.login),
        blocked: blockers.some((blocker) => blocker.state === "open"),
      })),
    );
  }
}
