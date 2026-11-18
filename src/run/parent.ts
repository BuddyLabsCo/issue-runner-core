import type {
  ParentDiscovery,
  ParentObservation,
  Ticket,
  Tracker,
} from "./contracts.ts";
import {
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
  signal: AbortSignal;
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

function validateScope(
  repository: string,
  { parent, children }: ParentObservation,
): void {
  validateParent(parent);
  validateChildRepositories(repository, children, parent.repositoryId);
  validateChildren(parent, children);
}

function closeParent(input: ParentScope): Promise<boolean> {
  const { repository, parentTicket, tracker, read, signal } = input;
  const target = `parent:${parentTicket}`;
  const phase = "parent_completion";
  const inspect = () =>
    read(
      "read_parent_completion",
      target,
      async () => {
        const scope = await tracker.readParentCompletion(
          repository,
          parentTicket,
          signal,
        );
        validateScope(repository, scope);
        return scope;
      },
      { phase },
    );
  return read(
    "close_parent",
    target,
    async () => {
      const { parent, children } = await inspect();
      if (parent.state === "closed") return true;
      if (children.some((ticket) => ticket.state === "open")) return false;
      const confirmed = await tracker.closeParent(parent, signal);
      if (
        confirmed.parent.state !== "closed" ||
        confirmed.parent.stateReason !== "completed"
      )
        throw new Error("Parent closure has not been confirmed");
      try {
        validateScope(repository, confirmed);
      } catch (error) {
        // Reconcile uncertain mutation evidence before applying scope policy.
        throw new Error(
          `Parent closure has not been confirmed: ${String(error)}`,
          {
            cause: error,
          },
        );
      }
      return true;
    },
    {
      phase,
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
  eligibleIssues: (tickets: BatchTicket[]) => Promise<number[]>;
  runBatch: (
    tickets: BatchTicket[],
    eligible: number[],
  ) => Promise<{ result: RunSummary; selected: number[] }>;
  maintenancePending: () => boolean;
}

function discoverBatch(input: ParentRun) {
  const { read, repository, parentTicket, tracker, markers } = input;
  return read("discover_parent", `parent:${parentTicket}`, async () => {
    const { parent, children, reservation, runner } =
      await tracker.discoverParent(
        repository,
        parentTicket,
        markers,
        input.signal,
      );
    validateScope(repository, { parent, children });
    const tickets = parentBatchTickets(children);
    const eligible =
      parent.state === "open" ? await input.eligibleIssues(tickets) : [];
    if (eligible.length && !(reservation && runner))
      throw new Error(
        "GitHub did not resolve the configured Reservation label or Runner account",
      );
    return { parent, tickets, eligible };
  });
}

export async function runParent(input: ParentRun): Promise<RunSummary> {
  let hadChildren = false;
  while (!input.maintenancePending()) {
    const { parent, tickets, eligible } = await discoverBatch(input);
    if (parent.state === "closed")
      return { ...input.summary, outcome: "succeeded" };
    if (!hadChildren && tickets.length === 0)
      return (await input.runBatch(tickets, eligible)).result;
    hadChildren = true;
    const open = tickets.filter((ticket) => ticket.state === "open");
    const batch =
      open.length > 0 ? await input.runBatch(tickets, eligible) : undefined;
    if (input.maintenancePending()) break;
    if (
      batch?.result.outcome === "succeeded" &&
      open.some((ticket) => !batch.selected.includes(ticket.number))
    )
      continue;
    if (await closeParent(input))
      return { ...input.summary, outcome: "succeeded" };
    if (batch && batch.result.outcome !== "succeeded") break;
  }
  return { ...input.summary, outcome: "incomplete" };
}
