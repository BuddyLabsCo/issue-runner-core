import type {
  ImplementationProgress,
  PublicationProgress,
} from "../recovery.ts";
import { nonempty } from "../agent/handoff.ts";
import { verifiedImplementation } from "./review.ts";
import { pushedRepairs } from "./repair.ts";

export function verifiedPublication(progress: ImplementationProgress) {
  const publication = progress.publication;
  const result = verifiedImplementation(progress);
  const head = result.commits.at(-1)?.sha;
  if (
    !publication ||
    !nonempty(publication.repositoryId) ||
    (publication.creationAttempted !== undefined &&
      publication.creationAttempted !== true) ||
    (!["pending_push", "pushed", "pending_pr"].includes(publication.phase) &&
      !publication.pullRequest) ||
    (publication.pullRequest !== undefined &&
      (!nonempty(publication.pullRequest.id) ||
        !Number.isSafeInteger(publication.pullRequest.number) ||
        publication.pullRequest.number <= 0 ||
        !nonempty(publication.pullRequest.url) ||
        publication.pullRequest.url.toLowerCase() !==
          `https://github.com/${progress.repository}/pull/${publication.pullRequest.number}`.toLowerCase() ||
        publication.pullRequest.branch !== publication.branch ||
        publication.pullRequest.targetBranch !== publication.targetBranch ||
        !/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/u.test(
          publication.pullRequest.headSha,
        ) ||
        publication.pullRequest.draft !== false ||
        !["open", "merged"].includes(publication.pullRequest.state) ||
        !nonempty(publication.pullRequest.createdAt) ||
        !Number.isFinite(Date.parse(publication.pullRequest.createdAt)))) ||
    (publication.ci !== undefined &&
      (publication.ci.headSha !== publishedHead(publication) ||
        publication.ci.merged !== false ||
        !["mergeable", "conflicting", "unknown"].includes(
          publication.ci.mergeable,
        ) ||
        typeof publication.ci.mergeRequested !== "boolean" ||
        !nonempty(publication.ci.createdAt) ||
        !Number.isFinite(Date.parse(publication.ci.createdAt)) ||
        (publication.ci.mergeFailure !== null &&
          !nonempty(publication.ci.mergeFailure)))) ||
    !head ||
    publication.branch !== progress.branch ||
    publication.targetBranch !== progress.target_branch ||
    publication.headSha !== head ||
    publication.title !== progress.pr_title ||
    publication.body !== progress.pr_body ||
    JSON.stringify(publication.commits) !== JSON.stringify(result.commits) ||
    ![
      "pending_push",
      "pushed",
      "pending_pr",
      "pr_created",
      "checks_ready",
      "checks_failed",
      "conflict_repair",
      "pending_merge",
      "merge_requested",
      "merged",
      "delivered",
    ].includes(publication.phase)
  )
    throw new Error(
      "Publication evidence does not match the verified execution",
    );

  return publication;
}

export function publishedHead(publication: PublicationProgress): string {
  return (
    pushedRepairs(publication).at(-1)?.result?.commits.at(-1)?.sha ??
    publication.headSha
  );
}
