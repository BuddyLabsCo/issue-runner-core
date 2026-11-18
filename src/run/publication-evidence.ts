import { nonempty } from "../agent/handoff.ts";
import type {
  ImplementationProgress,
  PublicationProgress,
} from "../recovery.ts";
import { pushedRepairs } from "./repair.ts";
import { verifiedImplementation } from "./review.ts";

export function verifiedPublication(progress: ImplementationProgress) {
  const publication = progress.publication;
  const result = verifiedImplementation(progress);
  const head = result.commits.at(-1)?.sha;
  if (
    !publication ||
    !head ||
    !nonempty(publication.repositoryId) ||
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

  const pullRequest = publication.pullRequest;
  const recorded = !["pending_push", "pushed", "pending_pr"].includes(
    publication.phase,
  );
  if (
    (recorded &&
      (!pullRequest ||
        !nonempty(pullRequest.id) ||
        !Number.isSafeInteger(pullRequest.number) ||
        pullRequest.number <= 0 ||
        typeof pullRequest.url !== "string" ||
        pullRequest.url.toLowerCase() !==
          `https://github.com/${progress.repository}/pull/${pullRequest.number}`.toLowerCase() ||
        typeof pullRequest.createdAt !== "string" ||
        !Number.isFinite(Date.parse(pullRequest.createdAt)))) ||
    (!recorded && pullRequest !== undefined) ||
    (publication.phase === "pending_pr" &&
      publication.creationAttempted !== true)
  )
    throw new Error("Publication has invalid Pull Request checkpoint evidence");

  validateChecksCheckpoint(publication);
  return publication;
}

function validateChecksCheckpoint(publication: PublicationProgress): void {
  const state = publication.checksState;
  if (
    (publication.phase === "checks_ready" &&
      (!state ||
        !Array.isArray(publication.checks) ||
        !publication.checks.every(
          (check) => check?.bucket === "pass" || check?.bucket === "skipping",
        ))) ||
    (state !== undefined &&
      (state?.headSha !== publishedHead(publication) ||
        state.createdAt !== publication.pullRequest?.createdAt ||
        state.merged !== false ||
        state.mergeFailure !== null ||
        !["unknown", "mergeable", "conflicting"].includes(state.mergeable) ||
        !nonempty(state.mergeStateStatus) ||
        typeof state.isInMergeQueue !== "boolean" ||
        typeof state.isMergeQueueEnabled !== "boolean" ||
        (state.autoMergeEnabledAt !== null &&
          (typeof state.autoMergeEnabledAt !== "string" ||
            !Number.isFinite(Date.parse(state.autoMergeEnabledAt)))) ||
        (state.mergeQueueEntryId !== null &&
          !nonempty(state.mergeQueueEntryId)) ||
        state.mergeRequested !==
          (state.isInMergeQueue ||
            state.autoMergeEnabledAt !== null ||
            state.mergeQueueEntryId !== null)))
  )
    throw new Error("Publication has invalid CI checkpoint evidence");
}

export function publishedHead(publication: PublicationProgress): string {
  return (
    pushedRepairs(publication).at(-1)?.result?.commits.at(-1)?.sha ??
    publication.headSha
  );
}
