import type { LoadedProject } from "../config.ts";
import type {
  ImplementationProgress,
  PublicationProgress,
} from "../recovery.ts";
import type { CodeHost, PullRequestRecord } from "./contracts.ts";
import type { ReadOperation } from "./discovery.ts";
import type { RunContext } from "./run.ts";
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
  if (!head || !progress.pr_title || !progress.pr_body)
    throw new Error(
      "Publication requires verified commits and accepted Probe metadata",
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
  if (!progress.publication) {
    await read("verify_publication", target, async () => {
      await verify();
      if ((await remoteHead()) !== null)
        throw new Error(
          "Remote publication branch exists without recorded publication intent",
        );
    });
    progress.publication = {
      phase: "pending_push",
      branch: progress.branch,
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

  if (!completed && !publication.ciRepair && !publication.conflictRepair)
    await read("push_verified_branch", target, async () => {
      await verify();
      const remote = await remoteHead();
      if (remote === head) return;
      if (remote !== null || publication.phase !== "pending_push")
        throw new Error(
          "Remote publication branch advanced or disappeared; resolve remote state before retrying",
        );
      await context.git.push(progress.worktree, progress.branch, head);
      if ((await remoteHead()) !== head)
        throw new Error("Push has not been confirmed at the intended head");
    });
  if (!completed && publication.phase === "pending_push") {
    publication.phase = "pushed";
    await persist();
  }

  const matchingPullRequest = async (
    expectedHead = publishedHead(publication),
  ): Promise<PullRequestRecord | undefined> => {
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
    publication.pullRequest = {
      number: recovered.candidate.number,
      url: recovered.candidate.url,
    };
    publication.merge = recovered.merge;
    publication.phase = "merged";
    await persist();
    return `Merged PR ${recovered.candidate.url} awaits completed tracker confirmation`;
  }
  const pullRequest =
    publication.pullRequest ??
    (await read("publish_pull_request", target, async () => {
      await verify();
      if ((await remoteHead()) !== head)
        throw new Error(
          "Remote branch changed before Pull Request publication",
        );
      const existing = await matchingPullRequest();
      if (existing) return { number: existing.number, url: existing.url };
      // A lost response can only be retried after reconciliation and explicit operator input.
      if (publication.creationAttempted)
        await pauseForOperator(
          context.operator,
          "Pull Request creation outcome is uncertain and no exact match exists. Confirm remote state before retrying creation.",
          context.signal,
        );
      await verify();
      if ((await remoteHead()) !== head)
        throw new Error("Remote branch changed before Pull Request creation");
      // Recheck after any operator wait; a delayed creation may now be visible.
      const delayed = await matchingPullRequest();
      if (delayed) return { number: delayed.number, url: delayed.url };
      publication.phase = "pending_pr";
      publication.creationAttempted = true;
      await persist();
      context.signal?.throwIfAborted();
      return codeHost.createPullRequest({
        repository,
        targetBranch: publication.targetBranch,
        branch: publication.branch,
        title: publication.title,
        body: publication.body,
      });
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

function matchPublication(
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
    candidate.branch !== publication.branch ||
    candidate.targetBranch !== publication.targetBranch ||
    candidate.headSha !== expectedHead ||
    (candidate.state !== "open" && candidate.state !== "merged") ||
    candidate.draft === true ||
    (publication.pullRequest &&
      (candidate.number !== publication.pullRequest.number ||
        candidate.url !== publication.pullRequest.url))
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
