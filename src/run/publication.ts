import type { LoadedProject } from "../config.ts";
import type {
  ImplementationProgress,
  PublicationProgress,
} from "../recovery.ts";
import type { CodeHost, PullRequestRecord } from "./contracts.ts";
import { matchPublication, identity } from "./publication-identity.ts";
import type { ReadOperation } from "./discovery.ts";
import type { RunContext } from "./run.ts";
import { nonempty } from "../agent/handoff.ts";
import { verifiedImplementation } from "./review.ts";
import { verifyWorkspace } from "./verification.ts";
import { OperationStopped, pauseForOperator } from "./operations.ts";
import type { IssueStageContext } from "../agent/stage.ts";
import {
  repairPullRequest,
  pushedRepairs,
  inspectRepairAncestry,
  verifyRepairAncestry,
} from "./repair.ts";

// Publication policy follows the source workflow at 0adf499bf69217b56256ca2affb1c0dca0894110.
export async function publishImplementation(input: {
  progress: ImplementationProgress;
  loaded: LoadedProject;
  context: RunContext;
  codeHost: CodeHost;
  read: ReadOperation;
  persist: () => Promise<void>;
  beforeDispatch: () => Promise<boolean>;
  autoMerge: boolean;
  stageInput: IssueStageContext;
}): Promise<string> {
  const { progress, loaded, context, codeHost, read, persist, beforeDispatch } =
    input;
  const repository = progress.repository;
  const target = `ticket:${progress.ticket}`;
  const result = verifiedImplementation(progress);
  const head = result.commits.at(-1)?.sha;
  if (!head || !nonempty(progress.pr_title) || !nonempty(progress.pr_body))
    throw new Error(
      "Publication requires verified commits and accepted business handoff metadata",
    );
  const verify = async (requireEligibility = true) => {
    if (requireEligibility && !(await beforeDispatch()))
      throw new OperationStopped(
        "Issue eligibility changed before publication",
      );
    verifyWorkspace(progress, await context.git.inspect(progress), result);
    const repairs = progress.publication
      ? pushedRepairs(progress.publication)
      : [];
    for (const repair of repairs) {
      verifyWorkspace(
        repair,
        await context.git.inspect(repair),
        repair.result!,
      );
      verifyRepairAncestry(
        repair,
        await inspectRepairAncestry(context.git, repair),
      );
    }
  };
  const remoteHead = () => {
    context.signal?.throwIfAborted();
    return codeHost.getRemoteBranchHead(repository, progress.branch);
  };
  const fresh = !progress.publication;
  if (!progress.publication) {
    const initial = await read("verify_publication", target, async () => {
      await verify();
      const observation = await codeHost.observeBranch(
        repository,
        progress.branch,
      );
      if (observation.head !== null)
        throw new Error(
          "Remote publication branch exists without recorded publication intent",
        );
      return observation;
    });
    progress.publication = {
      phase: "pending_push",
      branch: progress.branch,
      repositoryId: initial.repositoryId,
      targetBranch: progress.target_branch,
      headSha: head,
      title: progress.pr_title,
      body: progress.pr_body,
      commits: structuredClone(result.commits),
    };
    await persist();
  }
  const publication = verifiedPublication(progress);
  const completed =
    input.stageInput.ticket.state === "closed" &&
    input.stageInput.ticket.stateReason === "completed";

  const observe = async (
    expectedHead = publishedHead(publication),
    allowMissing = false,
  ) => {
    context.signal?.throwIfAborted();
    const observation = await codeHost.observePublication(
      repository,
      publication.branch,
      publication.targetBranch,
    );
    if (observation.repositoryId !== publication.repositoryId)
      throw new Error("Publication repository identity changed");
    if (
      observation.head !== expectedHead &&
      !(allowMissing && observation.head === null)
    )
      throw new Error(
        completed
          ? "Remote publication branch advanced after merge"
          : "Remote publication branch advanced or disappeared; resolve remote state before retrying",
      );
    return matchPublication(publication, observation.candidates, expectedHead);
  };
  const matchingPullRequest = async (
    expectedHead = publishedHead(publication),
  ) => observe(expectedHead, completed);
  let pushAttempted = false;
  let postPushObserved = false;
  let postPushCandidate: PullRequestRecord | undefined;
  if (
    !completed &&
    !publication.ciRepair &&
    !publication.conflictRepair &&
    publication.phase === "pending_push"
  )
    await read("push_verified_branch", target, async () => {
      await verify();
      let needsPush = true;
      if (!fresh || pushAttempted) {
        const remote = await codeHost.observeBranch(
          repository,
          progress.branch,
        );
        if (remote.repositoryId !== publication.repositoryId)
          throw new Error("Publication repository identity changed");
        if (remote.head === head) needsPush = false;
        else if (remote.head !== null)
          throw new Error(
            "Remote publication branch advanced or disappeared; resolve remote state before retrying",
          );
      }
      if (needsPush) {
        pushAttempted = true;
        await context.git.push(progress.worktree, progress.branch, head);
      }
      const candidate = await observe();
      context.signal?.throwIfAborted();
      publication.phase = "pushed";
      await persist();
      postPushCandidate = candidate;
      postPushObserved = true;
    });

  if (completed) {
    const recovered = await read(
      "reconcile_completed_publication",
      target,
      async () => {
        await verify(false);
        const candidate = await matchingPullRequest();
        if (candidate?.state !== "merged") return;
        const merge = await codeHost.getPullRequest(
          repository,
          candidate.number,
        );
        if (!merge.merged || merge.headSha !== publishedHead(publication))
          throw new Error(
            "Pull Request merge does not match the recorded publication head",
          );
        const remote = await remoteHead();
        if (remote !== null && remote !== publishedHead(publication))
          throw new Error("Remote publication branch advanced after merge");
        return { candidate, merge };
      },
    );
    if (!recovered)
      throw new OperationStopped(
        "Completed Issue has no exact merged Pull Request; retained publication evidence",
      );
    publication.pullRequest = identity(recovered.candidate);
    publication.merge = recovered.merge;
    publication.phase = "merged";
    await persist();
    return `Merged PR ${recovered.candidate.url} awaits completed tracker confirmation`;
  }
  let createdNow = false;
  const pullRequest =
    publication.pullRequest ??
    (await read("publish_pull_request", target, async () => {
      await verify();
      const existing = postPushObserved ? postPushCandidate : await observe();
      postPushObserved = false;
      context.signal?.throwIfAborted();
      if (publication.phase === "pending_push") {
        publication.phase = "pushed";
        await persist();
      }
      if (existing) return identity(existing);
      if (publication.creationAttempted) {
        await pauseForOperator(
          context.operator,
          "Pull Request creation outcome is uncertain and no exact match exists. Confirm remote state before retrying creation.",
          context.signal,
        );
        await verify();
        const delayed = await observe();
        if (delayed) return identity(delayed);
      }
      publication.phase = "pending_pr";
      publication.creationAttempted = true;
      await persist();
      context.signal?.throwIfAborted();
      const candidate = await codeHost.createPullRequest({
        repository,
        repositoryId: publication.repositoryId,
        targetBranch: publication.targetBranch,
        branch: publication.branch,
        title: publication.title,
        body: publication.body,
      });
      const validated = matchPublication(publication, [candidate], head);
      if (validated?.state !== "open" || validated.draft !== false)
        throw new Error(
          "Created Pull Request does not match publication intent",
        );
      createdNow = true;
      return identity(validated);
    }));
  if (!publication.pullRequest) {
    publication.pullRequest = pullRequest;
    publication.phase = "pr_created";
    publication.discoveryNotBefore = context.clock.now().getTime() + 30_000;
    await persist();
  }
  const merged = new OperationStopped("Published Pull Request merged");
  try {
    const confirm = (
      expectedHead = publishedHead(publication),
      recoveringPush = false,
    ) =>
      read("confirm_publication", target, async () => {
        await verify();
        const observation = await codeHost.observePullRequest(
          repository,
          publication.branch,
          pullRequest.number,
        );
        const candidate = observation.pullRequest;
        const acceptedHead =
          recoveringPush && candidate.headSha === publishedHead(publication)
            ? publishedHead(publication)
            : expectedHead;
        if (
          observation.repositoryId !== publication.repositoryId ||
          candidate.headRepository.toLowerCase() !== repository.toLowerCase() ||
          candidate.id !== pullRequest.id ||
          candidate.number !== pullRequest.number ||
          candidate.url !== pullRequest.url ||
          candidate.createdAt !== pullRequest.createdAt ||
          candidate.branch !== publication.branch ||
          candidate.targetBranch !== publication.targetBranch ||
          candidate.draft !== false ||
          !["open", "merged"].includes(candidate.state) ||
          candidate.headSha !== acceptedHead ||
          observation.lastCommit !== acceptedHead ||
          (observation.head !== acceptedHead &&
            !(candidate.state === "merged" && observation.head === null))
        )
          throw new Error(
            "Pull Request identity or head mismatch during required checks",
          );
        if (
          observation.merge.headSha !== acceptedHead ||
          observation.merge.merged !== (candidate.state === "merged")
        )
          throw new Error(
            "Pull Request merge evidence does not match publication",
          );
        if (observation.merge.merged) {
          if (acceptedHead !== publishedHead(publication)) {
            const repair = [
              publication.ciRepair?.attempts.at(-1),
              publication.conflictRepair?.attempts.at(-1),
            ].find((attempt) => attempt?.pendingPush === acceptedHead);
            if (
              !repair?.result ||
              repair.verificationError ||
              repair.result.commits.at(-1)?.sha !== acceptedHead
            )
              throw new Error(
                "Merged repair head has no verified repair evidence",
              );
            verifyWorkspace(
              repair,
              await context.git.inspect(repair),
              repair.result,
            );
            verifyRepairAncestry(
              repair,
              await inspectRepairAncestry(context.git, repair),
            );
            repair.pushed = true;
            delete repair.pendingPush;
          }
          publication.merge = observation.merge;
          publication.phase = "merged";
          await persist();
          throw merged;
        }
        return observation;
      });
    const pendingPush =
      publication.ciRepair?.attempts.at(-1)?.pendingPush ??
      publication.conflictRepair?.attempts.at(-1)?.pendingPush;
    // Let the repair checkpoint a push already confirmed at its recorded head.
    if (!createdNow && (pendingPush || publication.phase !== "pr_created"))
      await confirm(pendingPush, Boolean(pendingPush));
    if (publication.phase === "conflict_repair") {
      do {
        await repairPullRequest({
          ...input.stageInput,
          kind: "conflict",
          git: context.git,
          read,
          confirm: async (head) => {
            await confirm(head);
          },
          remoteHead,
        });
      } while (publication.phase === "conflict_repair");
      if (publication.conflictRepair?.retryAuthorized)
        return "Conflict repair budget exhausted; awaiting refreshed merge evidence";
    }
    const repair = async () => {
      do {
        await repairPullRequest({
          kind: "ci",
          ...input.stageInput,
          git: context.git,
          read,
          confirm: async (head) => {
            await confirm(head);
          },
          remoteHead,
        });
      } while (
        publication.phase === "checks_failed" &&
        !publication.ciRepair?.retryAuthorized
      );
    };
    const pending = publication.ciRepair?.attempts.at(-1);
    if (
      pending &&
      !pending.pushed &&
      !pending.verificationError &&
      pending.result?.outcome !== "no_change"
    )
      await repair();
    for (;;) {
      if (publication.phase === "checks_ready") break;
      const wait =
        (publication.discoveryNotBefore ?? 0) - context.clock.now().getTime();
      if (wait > 0) {
        context.signal?.throwIfAborted();
        await context.clock.sleep(wait);
        context.signal?.throwIfAborted();
      }
      publication.checksDeadline ??=
        context.clock.now().getTime() +
        loaded.config.timeouts.requiredChecksMinutes * 60_000;
      await persist();
      for (;;) {
        const { checks, merge } = await confirm();
        publication.ciObservation = merge;
        createdNow = false;
        publication.checks = checks;
        if (
          checks.some(({ bucket }) => bucket === "fail" || bucket === "cancel")
        ) {
          publication.phase = "checks_failed";
          await persist();
          await repair();
          break;
        }
        if (!checks.some(({ bucket }) => bucket === "pending")) {
          publication.phase = "checks_ready";
          await persist();
          break;
        }
        await persist();
        const remaining =
          publication.checksDeadline - context.clock.now().getTime();
        if (remaining <= 0) {
          await pauseForOperator(
            context.operator,
            "Required checks timed out.",
            context.signal,
          );
          publication.checksDeadline =
            context.clock.now().getTime() +
            loaded.config.timeouts.requiredChecksMinutes * 60_000;
          await persist();
        } else {
          context.signal?.throwIfAborted();
          await context.clock.sleep(Math.min(10_000, remaining));
          context.signal?.throwIfAborted();
        }
      }
    }
  } catch (error) {
    if (error !== merged) throw error;
  }
  return `CI-ready PR ${pullRequest.url} retained with branch ${progress.branch}, Worktree ${progress.worktree}, handoffs and progress evidence${publication.ciRepair ? `; repair Worktrees: ${publication.ciRepair.attempts.map(({ worktree }) => worktree).join(", ")}` : ""}${input.autoMerge ? "; ready for integration" : "; auto-merge disabled"}`;
}

export function verifiedPublication(progress: ImplementationProgress) {
  const publication = progress.publication;
  const result = verifiedImplementation(progress);
  const head = result.commits.at(-1)?.sha;
  if (
    !publication ||
    !head ||
    !nonempty(publication.repositoryId) ||
    (publication.pullRequest &&
      (!nonempty(publication.pullRequest.id) ||
        !Number.isSafeInteger(publication.pullRequest.number) ||
        publication.pullRequest.number < 1 ||
        !nonempty(publication.pullRequest.url) ||
        !Number.isFinite(Date.parse(publication.pullRequest.createdAt)))) ||
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

  if (publication.phase === "checks_ready") {
    const observation = publication.ciObservation;
    if (
      observation?.headSha !== publishedHead(publication) ||
      observation.createdAt !== publication.pullRequest?.createdAt ||
      observation.merged ||
      typeof observation.mergeRequested !== "boolean" ||
      (observation.mergeFailure !== null &&
        typeof observation.mergeFailure !== "string") ||
      !["mergeable", "conflicting", "unknown"].includes(
        observation.mergeable,
      ) ||
      !nonempty(observation.mergeStateStatus) ||
      typeof observation.isInMergeQueue !== "boolean" ||
      typeof observation.isMergeQueueEnabled !== "boolean" ||
      !Array.isArray(publication.checks) ||
      publication.checks.some(
        (check) =>
          !nonempty(check.name) ||
          !nonempty(check.state) ||
          typeof check.link !== "string" ||
          !["pass", "skipping"].includes(check.bucket),
      )
    )
      throw new Error("Publication has invalid CI observation evidence");
  }

  return publication;
}

export function publishedHead(publication: PublicationProgress): string {
  return (
    pushedRepairs(publication).at(-1)?.result?.commits.at(-1)?.sha ??
    publication.headSha
  );
}
