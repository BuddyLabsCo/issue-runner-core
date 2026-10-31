import type { Ticket, Tracker } from "./contracts.ts";
import {
  hasOpenBlocker,
  readChildren,
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

async function readParentScope(input: ParentScope): Promise<{
  parent: Ticket;
  tickets: Ticket[];
}> {
  const { repository, parentTicket, tracker, read } = input;
  const parent = await read("read_parent", `parent:${parentTicket}`, () =>
    tracker.getParent(repository, parentTicket),
  );
  if (parent.state === "closed" && parent.stateReason === "not_planned")
    throw new OperatorCancelled("Parent Ticket is cancelled");
  if (parent.state === "closed" && parent.stateReason === null)
    throw new OperationStopped(
      "closed Parent Ticket has no supported closure reason",
    );
  const tickets = await readChildren(repository, parentTicket, tracker, read);
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
  return { parent, tickets };
}

function closeParent(input: ParentScope): Promise<boolean> {
  const { repository, parentTicket, tracker, read } = input;
  const inspect = async () => {
    const scope = await readParentScope(input);
    for (const ticket of scope.tickets)
      await hasOpenBlocker(repository, ticket.number, tracker, read);
    return scope;
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
    runBatch: (tickets: Ticket[]) => Promise<RunSummary>;
  },
): Promise<RunSummary> {
  let hadChildren = false;
  let previous: RunSummary | undefined;
  const reasons: string[] = [];
  for (;;) {
    const { parent, tickets } = await readParentScope(input);
    hadChildren ||= tickets.length > 0;
    if (parent.state === "closed")
      return { ...input.summary, outcome: "succeeded", reasons };
    if (!hadChildren) return input.runBatch(tickets);
    if (previous && previous.outcome !== "succeeded")
      return { ...input.summary, outcome: "incomplete", reasons };
    if (tickets.every((ticket) => ticket.state === "closed")) {
      if (await closeParent(input))
        return { ...input.summary, outcome: "succeeded", reasons };
      continue;
    }
    previous = await input.runBatch(tickets);
    reasons.push(...previous.reasons);
  }
}
