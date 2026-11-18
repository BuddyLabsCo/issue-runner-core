import type { Ticket, Tracker } from "./contracts.ts";
import { readChildren, type ReadOperation } from "./discovery.ts";
import { OperationStopped, OperatorCancelled } from "./operations.ts";
import type { RunSummary } from "./run.ts";

interface ParentScope {
  repository: string;
  parentTicket: number;
  tracker: Tracker;
  read: ReadOperation;
}

export async function readParentScope(
  input: ParentScope,
  discovery = false,
): Promise<{
  parent: Ticket;
  tickets: Ticket[];
}> {
  const { repository, parentTicket, tracker, read } = input;
  const observed = discovery
    ? await read("observe_parent", `parent:${parentTicket}`, () =>
        tracker.observeParent(repository, parentTicket),
      )
    : undefined;
  const parent =
    observed?.parent ??
    (await read("read_parent", `parent:${parentTicket}`, () =>
      tracker.getParent(repository, parentTicket),
    ));
  const tickets =
    observed?.tickets ??
    (await readChildren(repository, parentTicket, tracker, read));
  return validateScope(input, { parent, tickets });
}

function validateScope(
  input: ParentScope,
  { parent, tickets }: { parent: Ticket; tickets: Ticket[] },
) {
  const { repository } = input;
  if (parent.state === "closed" && parent.stateReason === "not_planned")
    throw new OperatorCancelled("Parent Ticket is cancelled");
  if (parent.state === "closed" && parent.stateReason === null)
    throw new OperationStopped(
      "closed Parent Ticket has no supported closure reason",
    );
  const foreignChild = tickets.find(
    (ticket) => ticket.repository?.toLowerCase() !== repository.toLowerCase(),
  );
  if (foreignChild)
    throw new Error(
      `cross-repository child ${foreignChild.repository}#${foreignChild.number} is unsupported`,
    );
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
  const inspect = async () =>
    validateScope(
      input,
      await tracker.observeParentCompletion(repository, parentTicket),
    );
  return read(
    "close_parent",
    `parent:${parentTicket}`,
    async () => {
      const scope = await inspect();
      if (scope.parent.state === "closed") return true;
      if (scope.tickets.some((ticket) => ticket.state === "open")) return false;
      const result = await tracker.closeParent(repository, scope.parent);
      let confirmed: ReturnType<typeof validateScope>;
      try {
        confirmed = validateScope(input, result);
      } catch (error) {
        if (error instanceof OperationStopped)
          throw new Error("Parent closure has not been confirmed", {
            cause: error,
          });
        throw error;
      }
      if (
        confirmed.parent.state !== "closed" ||
        confirmed.parent.stateReason !== "completed"
      )
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
    maintenancePending: () => boolean;
  },
): Promise<RunSummary> {
  let hadChildren = false;
  let previous: RunSummary | undefined;
  for (;;) {
    if (input.maintenancePending())
      return { ...input.summary, outcome: "incomplete" };
    const { parent, tickets } = await readParentScope(input, true);
    hadChildren ||= tickets.length > 0;
    if (parent.state === "closed")
      return {
        ...input.summary,
        outcome: "succeeded",
      };
    if (!hadChildren) return input.runBatch(tickets);
    if (tickets.every((ticket) => ticket.state === "closed")) {
      if (await closeParent(input))
        return {
          ...input.summary,
          outcome: "succeeded",
        };
      continue;
    }
    if (previous && previous.outcome !== "succeeded")
      return { ...input.summary, outcome: "incomplete" };
    previous = await input.runBatch(tickets);
  }
}
