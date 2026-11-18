import type { Ticket, Tracker } from "./contracts.ts";
import type { ReadOperation } from "./discovery.ts";
import { OperationStopped, OperatorCancelled } from "./operations.ts";
import type { RunSummary } from "./run.ts";

interface ParentScope {
  repository: string;
  parentTicket: number;
  runner: string;
  reservation: string;
  tracker: Tracker;
  read: ReadOperation;
}

async function readParentScope(
  input: ParentScope,
  discovery = false,
): Promise<{
  parent: Ticket;
  tickets: Ticket[];
}> {
  const { repository, parentTicket, tracker, read } = input;
  const { parent, tickets } = discovery
    ? await read("discover_parent", `parent:${parentTicket}`, () =>
        tracker.discoverParent(
          repository,
          parentTicket,
          input.runner,
          input.reservation,
        ),
      )
    : await read("read_parent_completion", `parent:${parentTicket}`, () =>
        tracker.readParentCompletion(repository, parentTicket),
      );
  return validateScope(repository, { parent, tickets });
}

function validateScope(
  repository: string,
  scope: { parent: Ticket; tickets: Ticket[] },
) {
  const { parent, tickets } = scope;
  if (parent.state === "closed" && parent.stateReason === "not_planned")
    throw new OperatorCancelled("Parent Ticket is cancelled");
  if (parent.state === "closed" && parent.stateReason === null)
    throw new OperationStopped(
      "closed Parent Ticket has no supported closure reason",
    );
  const foreignChild = tickets.find(
    (child) => child.repository?.toLowerCase() !== repository.toLowerCase(),
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
  const inspect = () => readParentScope(input);
  return read(
    "close_parent",
    `parent:${parentTicket}`,
    async () => {
      const scope = await inspect();
      if (scope.parent.state === "closed") return true;
      if (scope.tickets.some((ticket) => ticket.state === "open")) return false;
      const confirmation = await tracker.closeParent(repository, scope.parent);
      if (
        confirmation.tickets.some(
          (ticket) => ticket.state === "open" || ticket.stateReason === null,
        )
      )
        throw new Error("Parent closure has not been confirmed");
      validateScope(repository, confirmation);
      if (
        confirmation.parent.state !== "closed" ||
        confirmation.parent.stateReason !== "completed"
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

async function resumeBatch(
  input: ParentScope & {
    resumePending: boolean;
    runBatch: (tickets: Ticket[]) => Promise<RunSummary>;
  },
): Promise<RunSummary | undefined> {
  if (!input.resumePending) return undefined;
  const { tickets } = await readParentScope(input, true);
  return input.runBatch(tickets);
}

interface ParentRun extends ParentScope {
  summary: RunSummary;
  runBatch: (tickets: Ticket[]) => Promise<RunSummary>;
  maintenancePending: () => boolean;
  resumePending: boolean;
}

async function runParentRounds(
  input: ParentScope & {
    summary: RunSummary;
    runBatch: (tickets: Ticket[]) => Promise<RunSummary>;
    maintenancePending: () => boolean;
    resumePending: boolean;
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

export async function runParent(input: ParentRun): Promise<RunSummary> {
  const resumed = await resumeBatch(input);
  if (resumed && resumed.outcome !== "succeeded") return resumed;
  return runParentRounds(input);
}
