import type { ProjectConfig } from "../config.ts";
import type { Ticket, Tracker } from "./contracts.ts";
import type { ReadOperation } from "./discovery.ts";
import { OperatorCancelled } from "./operations.ts";

export async function startIssue(input: {
  number: number;
  config: ProjectConfig;
  tracker: Tracker;
  read: ReadOperation;
  parentTicket?: number;
  documentation?: boolean;
  restored: boolean;
  restarting: boolean;
  advance: <T>(action: () => Promise<T>) => Promise<T>;
}): Promise<{ ticket: Ticket; reason?: string }> {
  const {
    number,
    config,
    tracker,
    read,
    parentTicket,
    documentation,
    restored,
    restarting,
  } = input;
  const repository = config.repository;
  const { runnerAccount, reservationLabel } = config.tracker;
  let initiated = false;
  return await read("start_issue", `ticket:${number}`, async () => {
    const observation = await tracker.observeStart({
      repository,
      number,
      runner: runnerAccount,
      label: reservationLabel,
      ...(parentTicket === undefined ? {} : { parent: parentTicket }),
    });
    const ticket = observation.ticket;
    if (parentTicket !== undefined) {
      const parent = observation.parent;
      if (!parent || !observation.children)
        throw new Error("Incomplete Parent scope");
      if (parent.state === "closed") {
        if (parent.stateReason === "not_planned")
          throw new OperatorCancelled("Parent Ticket is cancelled");
        throw new Error("Parent Ticket changed to a terminal state");
      }
      if (!observation.children.some((child) => child.number === number))
        return { ticket, reason: "Issue left Parent scope" };
    }
    if (
      ticket.number !== number ||
      (ticket.repository !== undefined &&
        ticket.repository.toLowerCase() !== repository.toLowerCase())
    )
      throw new Error("Unexpected Issue ownership");
    if (ticket.state === "closed")
      return { ticket, reason: "Issue is already terminal" };
    if (documentation) {
      if (
        ticket.assignees?.length ||
        !ticket.labels?.includes(config.maintenanceTicket.label) ||
        ticket.labels.includes(reservationLabel)
      )
        return {
          ticket,
          reason:
            "Maintenance Ticket lost its standalone markers or became externally owned",
        };
    } else if (config.issueLabel && !ticket.labels?.includes(config.issueLabel))
      return { ticket, reason: `Issue is missing ${config.issueLabel}` };
    if (ticket.assignees?.some((account) => account !== runnerAccount))
      return { ticket, reason: "Issue is externally owned" };
    if (!ticket.blockers) throw new Error("Incomplete blocker facts");
    if (
      ticket.blockers.some(
        (blocker) => blocker.state === "closed" && blocker.stateReason === null,
      )
    )
      throw new Error("Blocker has unsupported terminal state");
    if (ticket.blockers.some((blocker) => blocker.state === "open"))
      return { ticket, reason: "Issue is blocked" };
    if (documentation) return { ticket };
    const hasRunner = ticket.assignees?.includes(runnerAccount) ?? false;
    const hasLabel = ticket.labels?.includes(reservationLabel) ?? false;
    if (restored && !(hasRunner && hasLabel))
      return {
        ticket,
        reason: "Recorded Reservation changed before continuation",
      };
    if (restored || (restarting && hasRunner && hasLabel)) return { ticket };
    if (!initiated && hasLabel)
      return {
        ticket,
        reason: `existing Reservation${hasRunner !== hasLabel ? " (partial)" : ""}; no recorded ownership for this Run`,
      };
    if (hasRunner && hasLabel) return { ticket };
    if (
      (!hasLabel && !observation.labelId) ||
      (!hasRunner && !observation.runnerId)
    )
      throw new Error("Reservation marker identity is unavailable");
    initiated = true;
    const confirmed = await input.advance(() =>
      tracker.reserveStart({
        ticket,
        ...(!hasLabel ? { labelId: observation.labelId } : {}),
        ...(!hasRunner ? { runnerId: observation.runnerId } : {}),
        label: reservationLabel,
        runner: runnerAccount,
      }),
    );
    return { ticket: { ...ticket, ...confirmed } };
  });
}
