import { isDeepStrictEqual } from "node:util";
import type { LoadedProject } from "../config.ts";
import type { ReservationIdentity } from "../recovery.ts";
import type { ReservationMarkers, Ticket, Tracker } from "./contracts.ts";
import { validateChildRepositories, type ReadOperation } from "./discovery.ts";
import { OperatorCancelled, OperationStopped } from "./operations.ts";
import { ensureRepositoryLabel } from "./repository-label.ts";
import type { ViewerLookup } from "./viewer.ts";

export function startIssue(input: {
  number: number;
  parentTicket?: number;
  config: LoadedProject["config"];
  tracker: Tracker;
  read: ReadOperation;
  advance?: <T>(action: () => Promise<T>) => Promise<T>;
  recorded?: ReservationIdentity;
  viewer: ViewerLookup;
  restarting: boolean;
  signal?: AbortSignal;
}): Promise<{
  ticket: Ticket;
  reason?: string;
  reservation?: ReservationIdentity;
}> {
  const {
    number,
    parentTicket,
    config,
    tracker,
    read,
    recorded,
    signal,
    viewer,
  } = input;
  const { repository } = config;
  const repositoryName = repository.toLowerCase();
  const { reservationLabel } = config.tracker;
  let attempted:
    { identity: ReservationIdentity; canAddRunner: boolean } | undefined;
  return read(
    "start_issue",
    `ticket:${number}`,
    async function start(prepareLabel = true): ReturnType<typeof startIssue> {
      const {
        issue,
        scope,
        reservation,
        viewer: resolvedViewer,
      } = await tracker.readIssueStart(
        repository,
        number,
        config.tracker,
        parentTicket,
        signal,
      );
      viewer.seed(resolvedViewer);
      if (!resolvedViewer)
        throw new Error(
          "gh must be authenticated as a normal GitHub user; GitHub did not resolve the authenticated viewer",
        );
      const { labels, assignees, blockers, ...snapshot } = issue;
      const ticket: Ticket = {
        ...snapshot,
        labels: labels.map(({ name }) => name),
        assignees: assignees.map(({ login }) => login),
      };
      if (
        issue.number !== number ||
        issue.repository.toLowerCase() !== repositoryName
      )
        throw new Error("Unexpected Issue ownership");
      if (parentTicket !== undefined) {
        if (
          scope?.parent.number !== parentTicket ||
          scope.parent.repository.toLowerCase() !== repositoryName ||
          scope.parent.repositoryId !== issue.repositoryId
        )
          throw new Error("Unexpected Parent Ticket ownership");
        if (scope.parent.state === "closed") {
          if (scope.parent.stateReason === "not_planned")
            throw new OperatorCancelled("Parent Ticket is cancelled");
          throw new OperationStopped(
            "Parent Ticket changed to a terminal state",
          );
        }
        validateChildRepositories(
          repository,
          scope.children,
          issue.repositoryId,
        );
        const member = scope.children.find((child) => child.number === number);
        if (!member)
          return {
            ticket: { number, state: "open", stateReason: null },
            reason: "Issue left Parent scope",
          };
        if (member.id !== issue.id)
          throw new Error("Unexpected Issue identity in Parent scope");
        if (
          member.state !== issue.state ||
          member.stateReason !== issue.stateReason
        )
          throw new Error("Conflicting Issue state in Parent scope");
      }
      if (
        recorded &&
        (recorded.issueId !== issue.id ||
          recorded.repositoryId !== issue.repositoryId)
      )
        throw new OperationStopped(
          "Recorded Issue identity changed before continuation",
        );
      if (issue.state === "closed")
        return { ticket, reason: "Issue is already terminal" };
      const markerIneligibility = ({
        labels,
        assignees,
      }: ReservationMarkers) => {
        if (
          assignees.some(
            ({ id, login }) =>
              id === resolvedViewer.id &&
              login.toLowerCase() !== resolvedViewer.login.toLowerCase(),
          )
        )
          throw new Error("Conflicting login for the authenticated viewer ID");
        if (
          config.issueLabel &&
          !labels.some(({ name }) => name === config.issueLabel)
        )
          return `Issue is missing ${config.issueLabel}`;
        if (assignees.some(({ id }) => id !== resolvedViewer.id))
          return "Issue is externally owned";
      };
      const reason = markerIneligibility(issue);
      if (reason) return { ticket, reason };
      if (blockers.some((blocker) => blocker.state === "open"))
        return { ticket, reason: "Issue is blocked" };

      const hasLabel = labels.some(({ name }) => name === reservationLabel);
      const hasRunner = assignees.length > 0;
      const identity = reservation && {
        issueId: issue.id,
        repositoryId: issue.repositoryId,
        labelId: reservation.id,
        runnerId: resolvedViewer.id,
      };
      const reservationLabelsMatch = (labels: ReservationMarkers["labels"]) =>
        labels.every(
          ({ id, name }) =>
            (name === reservationLabel) === (id === reservation?.id),
        );
      const labelsMatch = reservationLabelsMatch(labels);
      const reserved = hasLabel && hasRunner && labelsMatch;
      if (recorded && (!reserved || !isDeepStrictEqual(identity, recorded)))
        return {
          ticket,
          reason: "Recorded Reservation changed before continuation",
        };
      if (
        hasLabel &&
        !attempted &&
        !recorded &&
        !(input.restarting && reserved)
      )
        return {
          ticket,
          reason: `existing Reservation${hasRunner ? "" : " (partial)"}; no recorded ownership for this Run`,
        };
      if (
        attempted &&
        (!isDeepStrictEqual(identity, attempted.identity) ||
          (!hasRunner && !attempted.canAddRunner))
      )
        return { ticket, reason: "Reservation changed during Issue start" };
      if (prepareLabel && !reservation) {
        await ensureRepositoryLabel(
          tracker,
          read,
          repository,
          reservationLabel,
          "reservation",
          "never",
        );
        return start(false);
      }
      if (!identity || !labelsMatch)
        throw new Error(
          "GitHub did not resolve the configured Reservation label or authenticated viewer",
        );
      if (reserved) return { ticket, reservation: identity };

      // Only an attempted write in this operation can explain newly observed markers.
      const reserve = () => {
        attempted ??= { identity, canAddRunner: !hasRunner };
        return tracker.reserveIssue(
          {
            issue,
            reservation,
            viewer: resolvedViewer,
            addLabel: !hasLabel,
            addRunner: !hasRunner,
          },
          signal,
        );
      };
      const confirmed = await (input.advance
        ? input.advance(reserve)
        : reserve());
      ticket.labels = confirmed.labels.map(({ name }) => name);
      ticket.assignees = confirmed.assignees.map(({ login }) => login);
      const confirmationReason = markerIneligibility(confirmed);
      if (confirmationReason) return { ticket, reason: confirmationReason };
      if (
        !ticket.labels.includes(reservationLabel) ||
        !reservationLabelsMatch(confirmed.labels) ||
        confirmed.assignees.length !== 1
      )
        throw new Error("Returned markers do not confirm the Reservation");
      return { ticket, reservation: identity };
    },
  );
}
