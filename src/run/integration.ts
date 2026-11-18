import {
  publishedHead,
  verifiedPublication,
  verifyPublicationRecord,
} from "./publication-evidence.ts";
import type { LoadedProject } from "../config.ts";
import type { ImplementationProgress } from "../recovery.ts";
import type {
  CodeHost,
  DeliveryObservation,
  PullRequestIdentity,
  PullRequestMergeFacts,
  Ticket,
  Tracker,
} from "./contracts.ts";
import type { ReadOperation } from "./discovery.ts";
import type { RunContext, RunSummary } from "./run.ts";
import { pendingRepair } from "./repair.ts";
import {
  OperationStopped,
  pauseForOperator,
  TicketSkipped,
} from "./operations.ts";

export async function integrateImplementation(input: {
  progress: ImplementationProgress;
  loaded: LoadedProject;
  context: RunContext;
  codeHost: CodeHost;
  tracker: Tracker;
  read: ReadOperation;
  persist: () => Promise<void>;
  beforeDispatch?: () => Promise<boolean>;
  issueClosureReason: Ticket["stateReason"];
  continuePublication: (observedConflict?: boolean) => Promise<string>;
}): Promise<{ outcome: "succeeded"; reason: string }> {
  const { progress, loaded, context, codeHost, tracker, read, persist } = input;
  const publication = verifiedPublication(progress);
  if (
    !publication.pullRequest ||
    ![
      "checks_ready",
      "conflict_repair",
      "pending_merge",
      "merge_requested",
      "merged",
      "delivered",
    ].includes(publication.phase)
  )
    throw new Error("Integration requires a recorded CI-ready Pull Request");

  const { repository, ticket } = progress;
  const pullRequest = publication.pullRequest;
  const target = `ticket:${ticket}`;
  const mergeOperation = "request_squash_merge";
  const mergeKey = JSON.stringify([mergeOperation, target]);
  const admin = loaded.config.codeHost.adminMerge;
  const now = () => context.clock.now().getTime();
  const explicitConflict = "Pull Request has an explicit merge conflict";
  const mergeTimeout = loaded.config.timeouts.mergeQueueMinutes * 60_000;
  const observe = async () => {
    const observed = await read("confirm_merge", target, async () => {
      const result = await codeHost.observeDelivery(
        { repository, number: pullRequest.number, ticket },
        context.signal,
      );
      verifyPublicationRecord(publication, result.pullRequest, true);
      const { issue, merge } = result;
      if (
        result.repositoryId !== publication.repositoryId ||
        issue.number !== ticket ||
        issue.repositoryId !== result.repositoryId ||
        issue.repository.toLowerCase() !== repository.toLowerCase() ||
        (progress.reservation && issue.id !== progress.reservation.issueId) ||
        !Array.isArray(issue.labels) ||
        !issue.labels.every(
          (label) => typeof label === "string" && label.trim(),
        )
      )
        throw new Error("Issue delivery identity or labels are incomplete");
      if (
        result.pullRequest.headSha !== publishedHead(publication) ||
        merge.headSha !== result.pullRequest.headSha ||
        merge.createdAt !== pullRequest.createdAt ||
        merge.merged !== (result.pullRequest.state === "merged")
      )
        throw new Error(
          "Pull Request head changed before integration confirmation",
        );
      return result;
    });
    if (!observed.merge.merged && observed.issue.state === "closed")
      throw new OperationStopped("Issue is already terminal");
    return observed;
  };
  const sleep = async (ms: number) => {
    context.signal?.throwIfAborted();
    await context.clock.sleep(ms);
    context.signal?.throwIfAborted();
  };
  const requireEligibility = async (reason: string) => {
    if (input.beforeDispatch && !(await input.beforeDispatch()))
      throw new OperationStopped(reason);
  };
  const repair = async (reason: string) => {
    publication.conflict ??= reason;
    publication.phase = "conflict_repair";
    delete publication.mergeDeadline;
    await persist();
    await input.continuePublication(true);
  };
  const waitForMergeability = async () => {
    publication.mergeDeadline ??= now() + mergeTimeout;
    await persist();
    const remaining = publication.mergeDeadline - now();
    if (remaining > 0) await sleep(Math.min(10_000, remaining));
    else {
      await pauseForOperator(
        context.operator,
        "Mergeability observation timed out.",
        context.signal,
      );
      delete publication.mergeDeadline;
      await persist();
    }
  };

  let observation: DeliveryObservation | undefined;
  const interruptedRepair = publication.conflictRepair?.attempts.at(-1);
  if (
    publication.phase === "conflict_repair" &&
    pendingRepair(interruptedRepair)
  ) {
    const assignmentUnsent =
      !interruptedRepair.invocation ||
      (interruptedRepair.pendingPrompt !== undefined &&
        interruptedRepair.superseded.length === 0);
    if (input.issueClosureReason !== null || assignmentUnsent)
      observation = await observe();
    const state = observation?.merge;
    if (
      !state ||
      (!state.merged && !state.mergeRequested && state.mergeFailure === null)
    ) {
      await input.continuePublication();
      observation = undefined;
    }
  }
  while (!publication.merge?.merged) {
    const checked =
      publication.phase === "checks_ready"
        ? publication.checksState
        : undefined;
    // Resolve adverse CI facts again before opening a repair or blocking a Batch.
    if (!checked || conflicting(checked) || blocked(checked, admin))
      observation ??= await observe();
    const state = observation?.merge ?? checked!;
    if (state.merged) {
      publication.merge = state;
      publication.phase = "merged";
      if (progress.operations) delete progress.operations[mergeKey];
      await persist();
      break;
    }
    if (input.issueClosureReason !== null)
      throw new OperationStopped("Issue is already terminal");
    if (state.mergeFailure !== null) {
      await pauseForOperator(
        context.operator,
        state.mergeFailure,
        context.signal,
      );
      if (publication.phase === "merge_requested") {
        publication.phase = "pending_merge";
        delete publication.mergeDeadline;
        await persist();
      }
      observation = undefined;
      continue;
    }
    const repairBudget = publication.conflictRepair;
    if (
      !state.mergeRequested &&
      publication.conflict &&
      repairBudget?.consumed === 2 &&
      !repairBudget.retryAuthorized &&
      !pendingRepair(repairBudget.attempts.at(-1))
    ) {
      await repair(publication.conflict);
      observation = undefined;
      continue;
    }
    if (
      publication.conflictRepair?.retryAuthorized &&
      publication.conflict &&
      !state.mergeRequested
    ) {
      if (!conflicting(state)) {
        if (state.mergeable === "unknown") {
          await waitForMergeability();
        } else {
          delete publication.conflict;
          delete publication.mergeDeadline;
          publication.phase = "pr_created";
          publication.discoveryNotBefore = now() + 30_000;
          await persist();
          await input.continuePublication();
        }
        observation = undefined;
        continue;
      }
    }
    if (!state.mergeRequested && conflicting(state)) {
      await requireEligibility(
        "Issue eligibility changed before conflict repair",
      );
      await repair(explicitConflict);
      observation = undefined;
      continue;
    }
    if (!state.mergeRequested && publication.phase !== "merge_requested") {
      const previousAttempt = progress.operations?.[mergeKey];
      publication.phase = "pending_merge";
      await persist();
      let firstState = previousAttempt ? undefined : state;
      const conflict = await read<string | undefined>(
        mergeOperation,
        target,
        async () => {
          if (!firstState) observation = await observe();
          const current = firstState ?? observation!.merge;
          firstState = undefined;
          if (
            current.mergeFailure !== null ||
            current.merged ||
            current.mergeRequested
          )
            return;
          if (conflicting(current)) return explicitConflict;
          if (blocked(current, admin))
            throw new Error(
              `Pull Request merge is ${current.mergeStateStatus}`,
            );
          await requireEligibility(
            "Issue eligibility changed before merge request",
          );
          const result = await codeHost.requestSquashMerge({
            pullRequest,
            headSha: publishedHead(publication),
            autoMerge: current.isMergeQueueEnabled && !admin,
          });
          if (result.outcome === "rejected") throw result.error;
          if (result.outcome === "conflict") {
            observation = await observe();
            if (
              observation.merge.mergeFailure !== null ||
              observation.merge.merged ||
              observation.merge.mergeRequested
            )
              return;
            return result.error instanceof Error
              ? result.error.message
              : String(result.error);
          }
          observation = undefined;
        },
        {
          reconcile: async () => {
            observation = await observe();
            const current = observation.merge;
            if (
              current.mergeFailure !== null ||
              current.merged ||
              current.mergeRequested
            )
              return { outcome: "completed", result: undefined };
            if (conflicting(current))
              return { outcome: "completed", result: explicitConflict };
            return { outcome: "pending" };
          },
        },
      );
      if (conflict !== undefined) {
        await repair(conflict);
        observation = undefined;
        continue;
      }
      if (observation && observation.merge.mergeFailure !== null) continue;
    }

    if (publication.phase !== "merge_requested") {
      publication.phase = "merge_requested";
      publication.mergeDeadline ??= now() + mergeTimeout;
      if (progress.operations) delete progress.operations[mergeKey];
      await persist();
    }
    if (!observation || observation.merge.merged) continue;

    await requireEligibility(
      "Issue eligibility changed while awaiting integration",
    );
    const remaining = publication.mergeDeadline! - now();
    if (remaining <= 0) {
      await pauseForOperator(
        context.operator,
        "Merge confirmation timed out.",
        context.signal,
      );
      publication.phase = "pending_merge";
      delete publication.mergeDeadline;
      await persist();
    } else await sleep(Math.min(10_000, remaining));
    observation = undefined;
  }

  const completedIssue = (result: DeliveryObservation) => {
    if (!result.merge.merged)
      throw new OperationStopped("Recorded merge could not be confirmed");
    if (
      result.issue.state === "closed" &&
      result.issue.stateReason !== "completed"
    )
      throw new OperationStopped(
        "Issue was cancelled after merge; no delivery credit",
      );
    return result;
  };

  const confirm = async () => completedIssue(await observe());
  let current = observation ? completedIssue(observation) : await confirm();
  if (publication.phase === "delivered") {
    if (current.issue.state !== "closed")
      throw new OperationStopped(
        "Previously delivered Issue is no longer closed/completed; retained delivery evidence",
      );
  } else {
    if (
      current.issue.state === "open" &&
      current.defaultBranch === publication.targetBranch
    ) {
      await sleep(10_000);
      current = await confirm();
    }
    if (current.issue.state === "open") {
      const closeOperation = "close_ticket";
      let first =
        !progress.operations?.[JSON.stringify([closeOperation, target])];
      await read(
        closeOperation,
        target,
        async () => {
          if (!first) current = await confirm();
          first = false;
          if (current.issue.state === "closed") return;
          if (input.beforeDispatch && !(await input.beforeDispatch())) {
            current = await confirm();
            if (current.issue.state === "closed") return;
            throw new OperationStopped(
              "Maintenance Ticket changed after merge",
            );
          }
          await tracker.closeTicket(repository, ticket);
          current = await confirm();
          if (current.issue.state !== "closed")
            throw new Error("Issue closure has not been confirmed");
        },
        {
          reconcile: async () => {
            current = await confirm();
            return current.issue.state === "closed"
              ? { outcome: "completed", result: undefined }
              : { outcome: "pending" };
          },
        },
      );
    }
    publication.closure = { state: "closed", stateReason: "completed" };
    publication.deliveryLabels = current.issue.labels;
    publication.phase = "delivered";
    await persist();
  }
  return {
    outcome: "succeeded",
    reason: `Issue #${ticket} delivered by confirmed squash integration ${pullRequest.url} and closed/completed tracker state`,
  };
}

function conflicting(state: PullRequestMergeFacts): boolean {
  return (
    state.mergeable === "conflicting" ||
    (!state.isMergeQueueEnabled && state.mergeStateStatus === "DIRTY")
  );
}

function blocked(state: PullRequestMergeFacts, admin: boolean): boolean {
  return (
    !admin &&
    !state.isMergeQueueEnabled &&
    (state.mergeStateStatus === "BLOCKED" ||
      state.mergeStateStatus === "BEHIND")
  );
}

export async function integrateBatch(input: {
  batch: number[];
  ready: Map<
    number,
    { pullRequest: PullRequestIdentity; complete: () => Promise<RunSummary> }
  >;
  results: RunSummary[];
}): Promise<RunSummary[]> {
  const { batch, ready, results } = input;
  if (
    batch.some(
      (number, index) =>
        !ready.has(number) &&
        results[index]!.outcome !== "no_work" &&
        results[index]!.outcome !== "succeeded",
    )
  )
    return results;
  const ordered = [...ready].sort(
    ([, a], [, b]) =>
      Date.parse(a.pullRequest.createdAt) -
        Date.parse(b.pullRequest.createdAt) ||
      a.pullRequest.number - b.pullRequest.number,
  );
  for (const [number, integration] of ordered) {
    const index = batch.indexOf(number);
    try {
      results[index] = await integration.complete();
    } catch (error) {
      if (!(error instanceof TicketSkipped)) throw error;
    }
    if (results[index]!.outcome !== "succeeded") break;
  }
  return results;
}

export async function closeDocumentationNoChange(input: {
  progress: ImplementationProgress;
  persist: () => Promise<void>;
  verify: () => Promise<void>;
  checkDeliveryEligibility: () => Promise<boolean>;
  inspectTicket: () => Promise<{ ticket: Ticket; reason?: string }>;
  tracker: Tracker;
  read: ReadOperation;
}): Promise<void> {
  const { progress, persist, verify, inspectTicket, read, tracker } = input;
  if (
    progress.purpose !== "documentation" ||
    progress.result?.outcome !== "no_change"
  )
    throw new Error("No-change closure requires verified documentation");
  await verify();
  progress.noChangeClosure = "pending";
  await persist();
  await read(
    "close_no_change",
    `ticket:${progress.ticket}`,
    async () => {
      let selected = await inspectTicket();
      if (selected.ticket.state !== "closed") {
        if (selected.reason || !(await input.checkDeliveryEligibility()))
          throw new OperationStopped(
            selected.reason ?? "Maintenance Ticket changed",
          );
        await verify();
        await tracker.closeTicket(progress.repository, progress.ticket);
        selected = await inspectTicket();
      }
      if (selected.ticket.state !== "closed")
        throw new Error("Maintenance Ticket closure has not been confirmed");
      if (selected.ticket.stateReason !== "completed")
        throw new OperationStopped(
          "Maintenance Ticket is not closed/completed",
        );
    },
    {
      reconcile: async () =>
        (await inspectTicket()).ticket.stateReason === "completed"
          ? { outcome: "completed", result: undefined }
          : { outcome: "pending" },
    },
  );
  progress.noChangeClosure = "completed";
  await persist();
}
