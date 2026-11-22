import type { PublicationProgress } from "../recovery.ts";
import type {
  CodeHost,
  PublicationObservation,
  PullRequestRecord,
  PullRequestObservation,
} from "./contracts.ts";
import type { ReadOperation } from "./discovery.ts";
import type { RunContext } from "./run.ts";
import { nonempty } from "../agent/handoff.ts";
import {
  publishedHead,
  verifiedPublication,
  verifyPublicationObservation,
  verifyPublicationRecord,
} from "./publication-evidence.ts";
import { verifiedImplementation } from "./review.ts";
import { verifyWorkspace } from "./verification.ts";
import { OperationStopped, pauseForOperator } from "./operations.ts";
import type { IssueStageContext } from "../agent/stage.ts";
import {
  repairPullRequest,
  acceptRepairPush,
  pushedRepairs,
  inspectRepairAncestry,
  pendingRepair,
  verifyRepairAncestry,
} from "./repair.ts";
import { recheckNoChangeCI } from "./ci-rerun.ts";

// Publication policy follows the source workflow at 0adf499bf69217b56256ca2affb1c0dca0894110.
export async function publishImplementation(
  input: IssueStageContext & {
    context: RunContext;
    codeHost: CodeHost;
    read: ReadOperation;
    autoMerge: boolean;
    observedConflict?: boolean;
  },
): Promise<string> {
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
    if (requireEligibility && beforeDispatch && !(await beforeDispatch()))
      throw new OperationStopped(
        "Maintenance Ticket eligibility changed before publication",
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
  const observeRecorded = (number: number) =>
    codeHost.observePullRequest(
      { repository, branch: publication.branch, number },
      context.signal,
    );
  const completed =
    input.ticket.state === "closed" && input.ticket.stateReason === "completed";

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
        const candidate =
          publication.pullRequest ??
          matchPublication(
            publication,
            (await observe(expectedHead, true)).candidates,
            expectedHead,
          );
        if (!candidate) return;
        const pendingRepair = [
          publication.ciRepair?.attempts.at(-1),
          publication.conflictRepair?.attempts.at(-1),
        ].find((attempt) => attempt?.pendingPush !== undefined);
        const observation = await observeRecorded(candidate.number);
        verifyPublicationObservation(
          publication,
          observation,
          expectedHead,
          pendingRepair?.pendingPush,
        );
        if (!observation.merge.merged) return;
        if (
          candidate.id !== observation.pullRequest.id ||
          candidate.url !== observation.pullRequest.url ||
          candidate.createdAt !== observation.pullRequest.createdAt
        )
          throw new Error("Pull Request identity or head mismatch");
        if (pendingRepair?.pendingPush === observation.pullRequest.headSha) {
          verifyWorkspace(
            pendingRepair,
            await context.git.inspect(pendingRepair),
            pendingRepair.result!,
          );
          verifyRepairAncestry(
            pendingRepair,
            await inspectRepairAncestry(context.git, pendingRepair),
          );
          acceptRepairPush(
            publication,
            pendingRepair,
            context.clock.now().getTime(),
          );
        }
        return { candidate: observation.pullRequest, merge: observation.merge };
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
  if (!publication.pullRequest) {
    const adopted = await read("publish_pull_request", target, async () => {
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
  const observeHead = async (pendingHead?: string) => {
    await verify();
    const observation = await observeRecorded(pullRequest.number);
    verifyPublicationObservation(
      publication,
      observation,
      publishedHead(publication),
      pendingHead,
    );
    return observation;
  };
  const stopIfMerged = async ({ merge }: PullRequestObservation) => {
    if (!merge.merged) return;
    publication.merge = merge;
    publication.phase = "merged";
    await persist();
    // Unwind nested repairs before dispatching or pushing again.
    throw merged;
  };
  const repairOptions = {
    ...input,
    git: context.git,
    read,
    observeHead,
    stopIfMerged,
  };
  try {
    if (publication.phase === "checks_ready") {
      publication.phase = "pr_created";
      delete publication.checksState;
    }
    if (publication.phase === "conflict_repair") {
      let alreadyObserved = input.observedConflict === true;
      do {
        await repairPullRequest({
          ...repairOptions,
          kind: "conflict",
          alreadyObserved,
        });
        alreadyObserved = false;
      } while (publication.phase === "conflict_repair");
      if (publication.conflictRepair?.retryAuthorized)
        return "Conflict repair budget exhausted; awaiting refreshed merge evidence";
    }
    if (pendingRepair(publication.ciRepair?.attempts.at(-1)))
      await repairPullRequest({ ...repairOptions, kind: "ci" });
    const checksDeadline = () =>
      context.clock.now().getTime() +
      loaded.config.timeouts.requiredChecksMinutes * 60_000;
    for (;;) {
      const wait =
        (publication.discoveryNotBefore ?? 0) - context.clock.now().getTime();
      if (wait > 0) {
        context.signal?.throwIfAborted();
        await context.clock.sleep(wait);
        context.signal?.throwIfAborted();
      }
      publication.checksDeadline ??= checksDeadline();
      const { checks, merge } = await read(
        "required_checks",
        target,
        async () => {
          const observation = await observeHead();
          await stopIfMerged(observation);
          return observation;
        },
      );
      publication.checks = checks;
      const failed = checks.filter(
        ({ bucket }) => bucket === "fail" || bucket === "cancel",
      );
      const pending = checks.some(({ bucket }) => bucket === "pending");
      const lastRepair = publication.ciRepair?.attempts.at(-1);
      const noChange =
        publication.phase === "checks_failed" &&
        lastRepair?.result?.outcome === "no_change" &&
        !lastRepair.verificationError &&
        !lastRepair.checksReconciled &&
        lastRepair.base === publishedHead(publication)
          ? lastRepair
          : undefined;
      let waiting = pending;
      if (noChange) {
        const decision = await recheckNoChangeCI({
          stage: input,
          codeHost,
          read,
          repair: noChange,
          failed,
          pending,
        });
        if (decision === "refresh") continue;
        waiting = decision === "wait";
      } else if (failed.length > 0) {
        publication.phase = "checks_failed";
        await persist();
        await repairPullRequest({
          ...repairOptions,
          kind: "ci",
          alreadyObserved: true,
        });
        continue;
      }
      if (!waiting) {
        if (noChange) noChange.checksReconciled = true;
        publication.checksState = merge;
        publication.phase = "checks_ready";
        await persist();
        break;
      }
      await persist();
      const remaining =
        publication.checksDeadline - context.clock.now().getTime();
      if (remaining > 0) {
        await context.clock.sleep(Math.min(10_000, remaining));
        continue;
      }
      const rerun = noChange?.actionsRerun;
      await pauseForOperator(
        context.operator,
        rerun
          ? `GitHub Actions rerun ${rerun.runId} timed out waiting for required checks.`
          : "Required checks timed out.",
        context.signal,
      );
      publication.checksDeadline = checksDeadline();
      await persist();
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
  if (related.length !== 1 || candidate.headSha !== expectedHead)
    throw new Error(
      "Pull Request identity or head mismatch, or multiple matching Pull Requests",
    );
  verifyPublicationRecord(publication, candidate);
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
