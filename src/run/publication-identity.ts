import type { PublicationProgress } from "../recovery.ts";
import type { PullRequestRecord } from "./contracts.ts";
import { nonempty } from "../agent/handoff.ts";

export function matchPublication(
  publication: PublicationProgress,
  candidates: PullRequestRecord[],
  expectedHead: string,
): PullRequestRecord | undefined {
  const related = candidates.filter(
    (candidate) =>
      candidate.branch === publication.branch ||
      (candidate.targetBranch === publication.targetBranch &&
        candidate.headSha === expectedHead),
  );
  if (related.length === 0) {
    if (publication.pullRequest)
      throw new Error("Recorded Pull Request is missing");
    return undefined;
  }
  const candidate = related[0]!;
  if (
    related.length !== 1 ||
    !nonempty(candidate.id) ||
    !Number.isSafeInteger(candidate.number) ||
    candidate.number < 1 ||
    !nonempty(candidate.url) ||
    !Number.isFinite(Date.parse(candidate.createdAt)) ||
    candidate.branch !== publication.branch ||
    candidate.targetBranch !== publication.targetBranch ||
    candidate.headSha !== expectedHead ||
    (candidate.state !== "open" && candidate.state !== "merged") ||
    candidate.draft !== false ||
    (publication.pullRequest &&
      (candidate.number !== publication.pullRequest.number ||
        candidate.url !== publication.pullRequest.url ||
        candidate.id !== publication.pullRequest.id ||
        candidate.createdAt !== publication.pullRequest.createdAt))
  )
    throw new Error(
      "Pull Request identity or head mismatch, or multiple matching Pull Requests",
    );
  return candidate;
}

export function identity(candidate: PullRequestRecord) {
  return {
    id: candidate.id,
    number: candidate.number,
    url: candidate.url,
    createdAt: candidate.createdAt,
  };
}
