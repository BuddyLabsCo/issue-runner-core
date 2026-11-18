import { object } from "../agent/handoff.ts";
import type { ReservationAdditions } from "../run/contracts.ts";
import type { GitHubClient } from "./github-client.ts";
import {
  issueFields,
  markerFields,
  parseIssueFact,
  readIssueMarkers,
} from "./github-issue-facts.ts";

export async function reserveIssue(
  client: GitHubClient,
  { issue, reservation, runner, addLabel, addRunner }: ReservationAdditions,
  signal?: AbortSignal,
) {
  if (!addLabel && !addRunner)
    throw new Error("Reservation mutation requires a marker to add");
  const labelField = addLabel
    ? `
    addReservation: addLabelsToLabelable(input: { labelableId: $issue, labelIds: [$label] }) {
      labelable { ... on Issue { ${issueFields} ${addRunner ? "" : markerFields} } }
    }
  `
    : "";
  const runnerField = addRunner
    ? `
    addRunner: addAssigneesToAssignable(input: { assignableId: $issue, assigneeIds: [$runner] }) {
      assignable { ... on Issue { ${issueFields} ${markerFields} } }
    }
  `
    : "";
  signal?.throwIfAborted();
  const { response, commandError } = await client.graphql(
    `mutation ReserveIssue($issue: ID!${addLabel ? ", $label: ID!" : ""}${addRunner ? ", $runner: ID!" : ""}) {
      ${labelField}
      ${runnerField}
    }`,
    {
      issue: issue.id,
      ...(addLabel ? { label: reservation.id } : {}),
      ...(addRunner ? { runner: runner.id } : {}),
    },
  );
  signal?.throwIfAborted();
  try {
    if (response.errors?.length)
      throw new Error(JSON.stringify(response.errors), { cause: commandError });
    if (commandError) throw commandError;
    const data = object(response.data);
    const payload = (alias: string, field: string) => {
      const raw = object(object(data[alias])[field]);
      const observed = parseIssueFact(raw);
      if (
        observed.id !== issue.id ||
        observed.number !== issue.number ||
        observed.repository.toLowerCase() !== issue.repository.toLowerCase() ||
        observed.repositoryId !== issue.repositoryId ||
        observed.state !== issue.state ||
        observed.stateReason !== issue.stateReason
      )
        throw new Error(`Unexpected Issue identity or state in ${alias}`);
      return raw;
    };
    if (addLabel && addRunner) payload("addReservation", "labelable");
    const confirmed = addRunner
      ? payload("addRunner", "assignable")
      : payload("addReservation", "labelable");
    return await readIssueMarkers(client, issue.id, confirmed, signal);
  } catch (error) {
    throw Object.assign(
      new Error(
        `GitHub Reservation was not confirmed: ${error instanceof Error ? error.message : String(error)}`,
        { cause: error },
      ),
      { response },
    );
  }
}
