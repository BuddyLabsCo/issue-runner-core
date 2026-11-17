import type { LoadedProject } from "../config.ts";
import type {
  ImplementationProgress,
  PublicationProgress,
} from "../recovery.ts";
import type { CodeHost, PublicationPullRequest } from "./contracts.ts";
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
  const { progress, loaded, context, codeHost, read, persist } = input;
  const repository = progress.repository;
  const target = `ticket:${progress.ticket}`;
  const result = verifiedImplementation(progress);
  const head = result.commits.at(-1)?.sha;
  if (!head || !nonempty(progress.pr_title) || !nonempty(progress.pr_body))
    throw new Error(
      "Publication requires verified commits and accepted business handoff metadata",
    );
  const verify = async (checkMaintenance = true) => {
    if (
      checkMaintenance &&
      progress.purpose === "documentation" &&
      !(await input.beforeDispatch())
    )
      throw new OperationStopped(
        "Maintenance Ticket changed before publication",
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
  let freshPush = false;
  if (!progress.publication) {
    const repositoryId = await read("verify_publication", target, async () => {
      await verify();
      const observed = await codeHost.observePublicationBranch(
        repository,
        progress.branch,
      );
      context.signal?.throwIfAborted();
      if (!nonempty(observed.repositoryId))
        throw new Error("Publication repository identity is missing");
      if (observed.head !== null)
        throw new Error(
          "Remote publication branch exists without recorded publication intent",
        );
      return observed.repositoryId;
    });
    progress.publication = {
      repositoryId,
      phase: "pending_push",
      branch: progress.branch,
      targetBranch: progress.target_branch,
      headSha: head,
      title: progress.pr_title,
      body: progress.pr_body,
      commits: structuredClone(result.commits),
    };
    await persist();
    freshPush = true;
  }
  const publication = verifiedPublication(progress);
  const completed =
    input.stageInput.ticket.state === "closed" &&
    input.stageInput.ticket.stateReason === "completed";

  if (!completed && !publication.ciRepair && !publication.conflictRepair)
    await read("push_verified_branch", target, async () => {
      await verify();
      if (!freshPush) {
        const remote = await remoteHead();
        if (remote === head) return;
        if (remote !== null || publication.phase !== "pending_push")
          throw new Error(
            "Remote publication branch advanced or disappeared; resolve remote state before retrying",
          );
      }
      freshPush = false;
      await context.git.push(progress.worktree, progress.branch, head);
    });
  if (!completed && publication.phase === "pending_push") {
    publication.phase = "pushed";
    await persist();
  }

  const matchingPullRequest = async (
    expectedHead = publishedHead(publication),
  ): Promise<PublicationPullRequest | undefined> => {
    context.signal?.throwIfAborted();
    return matchPublication(
      publication,
      await codeHost.listPullRequests(repository),
      expectedHead,
    );
  };
  if (completed) {
    const recovered = await read(
      "reconcile_completed_publication",
      target,
      async () => {
        await verify(false);
        const observed = await codeHost.observePublication({
          repository,
          branch: publication.branch,
          targetBranch: publication.targetBranch,
        });
        if (observed.repositoryId !== publication.repositoryId)
          throw new Error("Publication repository changed");
        const candidate = matchPublication(
          publication,
          observed.candidates,
          publishedHead(publication),
        );
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
    publication.pullRequest = recovered.candidate;
    publication.merge = recovered.merge;
    publication.phase = "merged";
    await persist();
    return `Merged PR ${recovered.candidate.url} awaits completed tracker confirmation`;
  }
  const pullRequest =
    publication.pullRequest ??
    (await read("publish_pull_request", target, async () => {
      await verify();
      const observe = async () => {
        const observed = await codeHost.observePublication({
          repository,
          branch: publication.branch,
          targetBranch: publication.targetBranch,
        });
        context.signal?.throwIfAborted();
        if (
          observed.repositoryId !== publication.repositoryId ||
          observed.head !== head
        )
          throw new Error(
            "Remote branch or repository changed before Pull Request publication",
          );
        return matchPublication(publication, observed.candidates, head);
      };
      const existing = await observe();
      if (existing) return existing;
      // A lost response can only be retried after reconciliation and explicit operator input.
      if (publication.creationAttempted) {
        await pauseForOperator(
          context.operator,
          "Pull Request creation outcome is uncertain and no exact match exists. Confirm remote state before retrying creation.",
          context.signal,
        );
        await verify();
        const delayed = await observe();
        if (delayed) return delayed;
      }
      publication.phase = "pending_pr";
      publication.creationAttempted = true;
      await persist();
      context.signal?.throwIfAborted();
      const created = await codeHost.createPullRequest({
        repository,
        repositoryId: publication.repositoryId,
        targetBranch: publication.targetBranch,
        branch: publication.branch,
        title: publication.title,
        body: publication.body,
      });
      if (
        created.state !== "open" ||
        !matchPublication(publication, [created], head)
      )
        throw new Error(
          "Created Pull Request does not match publication intent",
        );
      return created;
    }));
  if (!publication.pullRequest) {
    publication.pullRequest = pullRequest;
    publication.phase = "pr_created";
    publication.discoveryNotBefore = context.clock.now().getTime() + 30_000;
    await persist();
  }
  const merged = new OperationStopped("Published Pull Request merged");
  try {
    const confirm = (expectedHead = publishedHead(publication)) =>
      read("confirm_publication", target, async () => {
        await verify();
        if ((await remoteHead()) !== expectedHead)
          throw new Error("Remote branch advanced during required checks");
        const candidate = await matchingPullRequest(expectedHead);
        if (!candidate) throw new Error("Published Pull Request is missing");
        if (
          candidate.state === "merged" &&
          expectedHead === publishedHead(publication)
        ) {
          const merge = await codeHost.getPullRequest(
            repository,
            candidate.number,
          );
          if (!merge.merged || merge.headSha !== expectedHead)
            throw new Error(
              "Pull Request merge does not match the recorded publication head",
            );
          publication.merge = merge;
          publication.phase = "merged";
          await persist();
          // Unwind nested repairs before they can dispatch or push again.
          throw merged;
        }
      });
    const pendingPush =
      publication.ciRepair?.attempts.at(-1)?.pendingPush ??
      publication.conflictRepair?.attempts.at(-1)?.pendingPush;
    // Let the repair checkpoint a push already confirmed at its recorded head.
    await confirm(
      pendingPush &&
        (await read("read_pending_repair_head", target, remoteHead)) ===
          pendingPush
        ? pendingPush
        : undefined,
    );
    if (publication.phase === "conflict_repair") {
      do {
        await repairPullRequest({
          ...input.stageInput,
          kind: "conflict",
          git: context.git,
          read,
          confirm,
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
          confirm,
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
      await confirm();
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
        await confirm();
        const checks = await read("required_checks", target, () =>
          codeHost.getRequiredChecks(repository, pullRequest.number),
        );
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

function matchPublication<T extends PublicationPullRequest>(
  publication: PublicationProgress,
  candidates: T[],
  expectedHead: string,
): T | undefined {
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
    candidate.branch !== publication.branch ||
    candidate.targetBranch !== publication.targetBranch ||
    candidate.headSha !== expectedHead ||
    (candidate.state !== "open" && candidate.state !== "merged") ||
    candidate.draft === true ||
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
