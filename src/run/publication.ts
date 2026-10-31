import type { LoadedProject } from "../config.ts";
import type { ImplementationProgress } from "../recovery.ts";
import type { CodeHost, PullRequestRecord } from "./contracts.ts";
import type { ReadOperation } from "./discovery.ts";
import type { RunContext } from "./run.ts";
import { verifiedImplementation } from "./review.ts";
import { verifyWorkspace } from "./verification.ts";
import { OperationStopped, pauseForOperator } from "./operations.ts";
import type { IssueStageContext } from "../agent/stage.ts";
import { repairRequiredChecks } from "./ci-repair.ts";

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
  const verify = async () => {
    if (!(await beforeDispatch()))
      throw new OperationStopped(
        "Issue eligibility changed before publication",
      );
    verifyWorkspace(progress, await context.git.inspect(progress), result);
    const repair = progress.publication?.ciRepair?.attempts
      .filter((attempt) => attempt.pushed)
      .at(-1);
    if (repair)
      verifyWorkspace(
        repair,
        await context.git.inspect(repair),
        repair.result!,
      );
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
  const publication = progress.publication;
  const publishedHead = () =>
    publication.ciRepair?.attempts
      .filter((attempt) => attempt.pushed)
      .at(-1)
      ?.result?.commits.at(-1)?.sha ?? head;
  if (
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
    ].includes(publication.phase)
  )
    throw new Error(
      "Publication evidence does not match the verified execution",
    );

  if (!publication.ciRepair)
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
  if (publication.phase === "pending_push") {
    publication.phase = "pushed";
    await persist();
  }

  const matchingPullRequest = async (
    expectedHead = publishedHead(),
  ): Promise<PullRequestRecord | undefined> => {
    context.signal?.throwIfAborted();
    const candidates = await codeHost.listPullRequests(repository);
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
      candidate.state !== "open" ||
      candidate.draft === true ||
      (publication.pullRequest &&
        (candidate.number !== publication.pullRequest.number ||
          candidate.url !== publication.pullRequest.url))
    )
      throw new Error(
        "Pull Request identity or head mismatch, or multiple matching Pull Requests",
      );
    return candidate;
  };
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
  const confirm = (expectedHead = publishedHead()) =>
    read("confirm_publication", target, async () => {
      await verify();
      if ((await remoteHead()) !== expectedHead)
        throw new Error("Remote branch advanced during required checks");
      if (!(await matchingPullRequest(expectedHead)))
        throw new Error("Published Pull Request is missing");
    });
  const repair = async () => {
    do {
      await repairRequiredChecks({
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
  await confirm();
  return `CI-ready PR ${pullRequest.url} retained with branch ${progress.branch}, Worktree ${progress.worktree}, handoffs and progress evidence${publication.ciRepair ? `; repair Worktrees: ${publication.ciRepair.attempts.map(({ worktree }) => worktree).join(", ")}` : ""}${input.autoMerge ? "; integration remains downstream" : "; auto-merge disabled"}`;
}
