import { nonempty, object } from "../agent/handoff.ts";
import type { IssueFact } from "../run/contracts.ts";

export const issueFields =
  "id number state stateReason repository { id nameWithOwner }";

export function parseIssueFact(issue: Record<string, unknown>): IssueFact {
  const repository = object(issue.repository);
  if (
    !nonempty(issue.id) ||
    !nonempty(repository.id) ||
    !nonempty(repository.nameWithOwner)
  )
    throw new Error("GitHub issue has an invalid identity");
  if (
    typeof issue.number !== "number" ||
    !Number.isSafeInteger(issue.number) ||
    issue.number <= 0
  )
    throw new Error("GitHub issue has no valid number");
  const identity = {
    id: issue.id,
    number: issue.number,
    repository: repository.nameWithOwner,
    repositoryId: repository.id,
  };
  if (
    issue.state === "OPEN" &&
    (issue.stateReason === null || issue.stateReason === "REOPENED")
  )
    return { ...identity, state: "open", stateReason: null };
  if (
    issue.state !== "CLOSED" ||
    (issue.stateReason !== "COMPLETED" && issue.stateReason !== "NOT_PLANNED")
  )
    throw new Error(`Issue ${issue.number} has an unsupported terminal state`);
  return {
    ...identity,
    state: "closed",
    stateReason:
      issue.stateReason === "COMPLETED" ? "completed" : "not_planned",
  };
}

export function scopedIssue(
  raw: Record<string, unknown>,
  repo: Record<string, unknown>,
  repository: string,
  number: number,
  description: string,
) {
  const parent = parseIssueFact(raw);
  if (
    parent.number !== number ||
    parent.repository.toLowerCase() !== repository.toLowerCase() ||
    typeof repo.nameWithOwner !== "string" ||
    repo.nameWithOwner.toLowerCase() !== repository.toLowerCase() ||
    repo.id !== parent.repositoryId
  )
    throw new Error(`Unexpected ${description} ownership`);
  return parent;
}
