import type { LoadedProject } from "../config.ts";
import type {
  ImplementationProgress,
  PublicationProgress,
} from "../recovery.ts";
import type {
  CodeHost,
  PublicationObservation,
  PullRequestRecord,
} from "./contracts.ts";
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
  const observeBranch = () => {
    context.signal?.throwIfAborted();
    return codeHost.observeBranch(repository, progress.branch);
  };
  let freshPush = !progress.publication;
  if (!progress.publication) {
    const repositoryId = await read("verify_publication", target, async () => {
      await verify();
      const branch = await observeBranch();
      if (branch.headSha !== null)
        throw new Error(
          "Remote publication branch exists without recorded publication intent",
        );
      return branch.repositoryId;
    });
    progress.publication = {
      phase: "pending_push",
      repositoryId,
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
  const query = {
    repository,
    branch: publication.branch,
    targetBranch: publication.targetBranch,
  };
  const verifyRepository = (repositoryId: string) => {
    if (repositoryId !== publication.repositoryId)
      throw new Error("Remote publication repository changed");
  };
  const remoteHead = async () => {
    const observed = await observeBranch();
    verifyRepository(observed.repositoryId);
    return observed.headSha;
  };
  const observe = async (expectedHead: string, allowMissingBranch = false) => {
    context.signal?.throwIfAborted();
    const observed = await codeHost.observePublication(query, context.signal);
    verifyRepository(observed.repositoryId);
    if (
      observed.headSha !== expectedHead &&
      !(allowMissingBranch && observed.headSha === null)
    )
      throw new Error(
        allowMissingBranch
          ? "Remote publication branch advanced after merge"
          : "Remote publication branch advanced or disappeared; resolve remote state before retrying",
      );
    return observed;
  };
  const completed =
    input.stageInput.ticket.state === "closed" &&
    input.stageInput.ticket.stateReason === "completed";

  let pushedObservation: PublicationObservation | undefined;
  if (!completed && publication.phase === "pending_push") {
    const observed = await read("push_verified_branch", target, async () => {
      await verify();
      const remote = freshPush ? null : await remoteHead();
      freshPush = false;
      if (remote !== head) {
        if (remote !== null)
          throw new Error(
            "Remote publication branch advanced or disappeared; resolve remote state before retrying",
          );
        await context.git.push(progress.worktree, progress.branch, head);
      }
      return observe(head);
    });
    publication.phase = "pushed";
    await persist();
    pushedObservation = observed;
  }

  if (completed) {
    const recovered = await read(
      "reconcile_completed_publication",
      target,
      async () => {
        await verify(false);
        const expectedHead = publishedHead(publication);
        const { candidates } = await observe(expectedHead, true);
        const candidate = matchPublication(
          publication,
          candidates,
          expectedHead,
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
        return { candidate, merge };
      },
    );
    if (!recovered)
      throw new OperationStopped(
        "Completed Issue has no exact merged Pull Request; retained publication evidence",
      );
    publication.pullRequest = pullRequestIdentity(recovered.candidate);
    publication.merge = recovered.merge;
    publication.phase = "merged";
    await persist();
    return `Merged PR ${recovered.candidate.url} awaits completed tracker confirmation`;
  }
  let adopted: PullRequestRecord | undefined;
  if (!publication.pullRequest) {
    adopted = await read("publish_pull_request", target, async () => {
      await verify();
      const { candidates } = pushedObservation ?? (await observe(head));
      pushedObservation = undefined;
      const existing = matchPublication(publication, candidates, head);
      if (existing) return existing;
      // Reconcile again after the pause in case the previous creation became visible.
      if (publication.creationAttempted) {
        await pauseForOperator(
          context.operator,
          "Pull Request creation outcome is uncertain and no exact match exists. Confirm remote state before retrying creation.",
          context.signal,
        );
        await verify();
        const delayed = matchPublication(
          publication,
          (await observe(head)).candidates,
          head,
        );
        if (delayed) return delayed;
      }
      publication.phase = "pending_pr";
      publication.creationAttempted = true;
      await persist();
      context.signal?.throwIfAborted();
      const created = await codeHost.createPullRequest({
        ...query,
        repositoryId: publication.repositoryId,
        title: publication.title,
        body: publication.body,
      });
      if (created.state !== "open")
        throw new Error("Created Pull Request is not open");
      const candidate = matchPublication(publication, [created], head);
      if (!candidate)
        throw new Error("Created Pull Request identity or head mismatch");
      return candidate;
    });
    publication.pullRequest = pullRequestIdentity(adopted);
    publication.phase = "pr_created";
    publication.discoveryNotBefore = context.clock.now().getTime() + 30_000;
    await persist();
  }
  const pullRequest = publication.pullRequest;
  const merged = new OperationStopped("Published Pull Request merged");
  try {
    const confirm = (expectedHead = publishedHead(publication)) =>
      read("confirm_publication", target, async () => {
        await verify();
        const { candidates } = await observe(expectedHead);
        const candidate = matchPublication(
          publication,
          candidates,
          expectedHead,
        );
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
    if (!adopted || adopted.state === "merged")
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
    while (publication.phase !== "checks_ready") {
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
          await confirm();
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
    candidate.draft !== false ||
    (publication.pullRequest &&
      (candidate.id !== publication.pullRequest.id ||
        candidate.number !== publication.pullRequest.number ||
        candidate.url !== publication.pullRequest.url ||
        candidate.createdAt !== publication.pullRequest.createdAt))
  )
    throw new Error(
      "Pull Request identity or head mismatch, or multiple matching Pull Requests",
    );
  return candidate;
}

function pullRequestIdentity({
  id,
  number,
  url,
  createdAt,
}: PullRequestRecord) {
  return { id, number, url, createdAt };
}

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

  return publication;
}

export function publishedHead(publication: PublicationProgress): string {
  return (
    pushedRepairs(publication).at(-1)?.result?.commits.at(-1)?.sha ??
    publication.headSha
  );
}
