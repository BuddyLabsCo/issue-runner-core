import type { ProjectConfig } from "../config.ts";
import type { Ticket, Tracker } from "./contracts.ts";
import type { ReadOperation } from "./discovery.ts";
import { OperatorCancelled } from "./operations.ts";

export function startIssue(input: {
  number: number;
  parentTicket?: number;
  documentation?: boolean;
  config: ProjectConfig;
  tracker: Tracker;
  read: ReadOperation;
  restored: boolean;
  restarting: boolean;
}): Promise<{ ticket: Ticket; reason?: string }> {
  const { number, config, tracker, read } = input;
  const { runnerAccount, reservationLabel } = config.tracker;
  const repository = config.repository;
  let initiated = false;
  return read("start_issue", `ticket:${number}`, async () => {
    const facts = await tracker.readStart(
      repository,
      number,
      runnerAccount,
      reservationLabel,
      input.parentTicket,
    );
    if (input.parentTicket !== undefined && facts.parent.state === "closed") {
      if (facts.parent.stateReason === "not_planned")
        throw new OperatorCancelled("Parent Ticket is cancelled");
      throw new Error("Parent Ticket changed to a terminal state");
    }
    const ticket =
      input.parentTicket === undefined
        ? facts.parent
        : facts.tickets.find((child) => child.number === number);
    if (!ticket)
      return {
        ticket: { number, state: "open" as const, stateReason: null },
        reason: "Issue left Parent scope",
      };
    if (ticket.state === "closed")
      return { ticket, reason: "Issue is already terminal" };
    if (input.documentation) {
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
    if (ticket.blockers?.some((blocker) => blocker.state === "open"))
      return { ticket, reason: "Issue is blocked" };
    if (input.documentation) return { ticket };
    const hasRunner = ticket.assignees?.includes(runnerAccount) ?? false;
    const hasLabel = ticket.labels?.includes(reservationLabel) ?? false;
    if (input.restored)
      return hasRunner && hasLabel
        ? { ticket }
        : {
            ticket,
            reason: "Recorded Reservation changed before continuation",
          };
    if (!initiated && hasLabel && !(input.restarting && hasRunner))
      return {
        ticket,
        reason: `existing Reservation${hasRunner !== hasLabel ? " (partial)" : ""}; no recorded ownership for this Run`,
      };
    if (input.restarting && hasRunner && hasLabel) return { ticket };
    const label = hasLabel
      ? undefined
      : { id: facts.reservationId, name: reservationLabel };
    const runner = hasRunner
      ? undefined
      : { id: facts.runnerId, login: runnerAccount };
    if ((label && !label.id) || (runner && !runner.id))
      throw new Error("Missing Reservation marker identity");
    if (label || runner) {
      initiated = true;
      await tracker.addReservation(
        ticket,
        label as { id: string; name: string } | undefined,
        runner as { id: string; login: string } | undefined,
        reservationLabel,
        runnerAccount,
      );
    }
    return { ticket };
  });
}
