import {
  publishedHead,
  verifiedPublication,
  verifyPublicationObservation,
} from "./publication-evidence.ts";
import type { LoadedProject } from "../config.ts";
import type { ImplementationProgress } from "../recovery.ts";
import type { CodeHost, Ticket, Tracker } from "./contracts.ts";
import type { ReadOperation } from "./discovery.ts";
import type { RunContext, RunSummary } from "./run.ts";
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
  deferred: boolean;
  resuming: boolean;
  issueClosureReason: Ticket["stateReason"];
  continuePublication: (observedConflict?: boolean) => Promise<string>;
}): Promise<{ outcome: "succeeded" | "incomplete"; reason: string }> {
  const { progress, loaded, context, codeHost, tracker, read, persist } = input;
  const publication = verifiedPublication(progress);
  if (
    !publication?.pullRequest ||
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
  let head = publishedHead(publication);
  const { repository, ticket } = progress;
  const pullRequest = publication.pullRequest;
  const target = `ticket:${ticket}`;
  const observe = () =>
    read("confirm_merge", target, async () => {
      if (input.deferred) {
        const observation = await codeHost.observePullRequest(
          {
            repository,
            branch: publication.branch,
            number: pullRequest.number,
          },
          context.signal,
        );
        verifyPublicationObservation(publication, observation, head);
        return observation.merge;
      }
      const state = await codeHost.getPullRequest(
        repository,
        pullRequest.number,
      );
      if (state.headSha !== head)
        throw new Error(
          "Pull Request head changed before integration confirmation",
        );
      return state;
    });
  const repair = async (reason: string, observedConflict?: boolean) => {
    publication.conflict ??= reason;
    publication.phase = "conflict_repair";
    delete publication.mergeDeadline;
    await persist();
    await input.continuePublication(observedConflict);
    head = publishedHead(publication);
  };
  const sleep = async (ms: number) => {
    context.signal?.throwIfAborted();
    await context.clock.sleep(ms);
    context.signal?.throwIfAborted();
  };
  if (
    input.resuming &&
    (publication.phase === "merged" || publication.phase === "delivered") &&
    !(await observe()).merged
  )
    throw new OperationStopped("Recorded merge could not be confirmed");
  if (publication.phase === "conflict_repair") {
    if (input.issueClosureReason === "not_planned")
      throw new OperationStopped("Issue is cancelled");
    await input.continuePublication();
    head = publishedHead(publication);
  }
  if (publication.phase !== "merged" && publication.phase !== "delivered") {
    const deferredChecks = input.deferred ? publication.checksState : undefined;
    while (!publication.merge?.merged) {
      const checked =
        publication.phase === "checks_ready" &&
        publication.checksState !== deferredChecks
          ? publication.checksState
          : undefined;
      let state = checked ?? (await observe());
      if (state.merged) {
        publication.merge = state;
        publication.phase = "merged";
        await persist();
        break;
      }
      if (input.issueClosureReason !== null)
        throw new OperationStopped("Issue is already terminal");
      if (input.beforeDispatch && !(await input.beforeDispatch()))
        throw new OperationStopped(
          "Issue eligibility changed before integration",
        );
      if (
        publication.conflictRepair?.retryAuthorized &&
        publication.conflict &&
        !state.mergeRequested
      ) {
        if (state.mergeable === "unknown") {
          publication.mergeDeadline ??=
            context.clock.now().getTime() +
            loaded.config.timeouts.mergeQueueMinutes * 60_000;
          const remaining =
            publication.mergeDeadline - context.clock.now().getTime();
          await persist();
          if (remaining <= 0) {
            await pauseForOperator(
              context.operator,
              "Mergeability observation timed out.",
              context.signal,
            );
            delete publication.mergeDeadline;
            await persist();
          } else await sleep(Math.min(10_000, remaining));
          continue;
        }
        if (state.mergeable === "mergeable") {
          delete publication.conflict;
          delete publication.mergeDeadline;
          publication.phase = "pr_created";
          publication.discoveryNotBefore =
            context.clock.now().getTime() + 30_000;
          await persist();
          await input.continuePublication();
          head = publishedHead(publication);
          continue;
        }
      }
      if (!state.mergeRequested && state.mergeable === "conflicting") {
        await repair(
          publication.conflict ?? "Pull Request has an explicit merge conflict",
          checked !== undefined,
        );
        continue;
      }
      if (state.mergeFailure !== null) {
        await pauseForOperator(
          context.operator,
          state.mergeFailure,
          context.signal,
        );
        continue;
      }
      if (!state.mergeRequested && publication.phase !== "merge_requested") {
        const operation = "request_squash_merge";
        // A resumed dispatch can pause before its first attempt.
        let firstObservation =
          input.deferred &&
          publication.phase === "checks_ready" &&
          checked === undefined &&
          !progress.operations?.[JSON.stringify([operation, target])]
            ? state
            : undefined;
        publication.phase = "pending_merge";
        await persist();
        const request = await read(
          operation,
          target,
          async () => {
            state = firstObservation ?? (await observe());
            firstObservation = undefined;
            if (state.merged || state.mergeRequested)
              return { outcome: "accepted" as const };
            if (input.beforeDispatch && !(await input.beforeDispatch()))
              throw new OperationStopped(
                "Issue eligibility changed before merge request",
              );
            if (state.mergeable === "conflicting")
              return {
                outcome: "conflict" as const,
                error: new Error("Pull Request has an explicit merge conflict"),
              };
            if (state.mergeFailure !== null)
              throw new Error(state.mergeFailure);
            const result = await codeHost.requestSquashMerge({
              repository,
              pullRequest: pullRequest.number,
              headSha: state.headSha,
              admin: loaded.config.codeHost.adminMerge,
            });
            if (result.outcome === "rejected") throw result.error;
            return result;
          },
          {
            reconcile: async () => {
              state = await observe();
              return state.merged || state.mergeRequested
                ? {
                    outcome: "completed",
                    result: { outcome: "accepted" as const },
                  }
                : { outcome: "pending" };
            },
          },
        );
        if (request.outcome === "conflict") {
          await repair(
            request.error instanceof Error
              ? request.error.message
              : String(request.error),
          );
          continue;
        }
      }
      publication.phase = "merge_requested";
      publication.mergeDeadline ??=
        context.clock.now().getTime() +
        loaded.config.timeouts.mergeQueueMinutes * 60_000;
      await persist();
      for (;;) {
        state = await observe();
        if (state.merged) break;
        if (input.beforeDispatch && !(await input.beforeDispatch()))
          throw new OperationStopped(
            "Issue eligibility changed while awaiting integration",
          );
        if (!state.mergeRequested && state.mergeable === "conflicting") {
          await repair("Pull Request has an explicit merge conflict");
          break;
        }
        const remaining =
          publication.mergeDeadline - context.clock.now().getTime();
        if (state.mergeFailure !== null || remaining <= 0) {
          await pauseForOperator(
            context.operator,
            state.mergeFailure ?? "Merge confirmation timed out.",
            context.signal,
          );
          publication.phase = "pending_merge";
          delete publication.mergeDeadline;
          await persist();
          break;
        }
        await sleep(Math.min(10_000, remaining));
      }
    }
  }
  if (!publication.merge?.merged || publication.merge.headSha !== head)
    throw new Error("Delivery requires persisted merge confirmation");
  const completion = async () => {
    const current = await read("confirm_issue_delivery", target, async () => {
      const observed = await tracker.readIssueDelivery(
        repository,
        ticket,
        context.signal,
      );
      if (observed.number !== ticket || !Array.isArray(observed.labels))
        throw new Error("Delivery requires the observed Issue and its labels");
      return observed;
    });
    if (current.state === "closed" && current.stateReason !== "completed")
      throw new OperationStopped(
        "Issue was cancelled after merge; no delivery credit",
      );
    return current;
  };
  if (publication.phase === "delivered") {
    if (
      publication.closure?.state !== "closed" ||
      publication.closure.stateReason !== "completed" ||
      !Array.isArray(publication.deliveryLabels)
    )
      throw new Error(
        "Delivery requires persisted completed tracker state and labels",
      );
    if ((await completion()).state !== "closed")
      throw new OperationStopped(
        "Previously delivered Issue is no longer closed/completed; retained delivery evidence",
      );
    return {
      outcome: "succeeded",
      reason: `Issue #${ticket} delivered by confirmed squash integration ${pullRequest.url} and closed/completed tracker state`,
    };
  }
  let current = await completion();
  if (current.state === "open") {
    let beforeClose: typeof current | undefined = current;
    current = await read(
      "close_ticket",
      target,
      async () => {
        const observed = beforeClose ?? (await completion());
        beforeClose = undefined;
        if (observed.state === "closed") return observed;
        if (input.beforeDispatch && !(await input.beforeDispatch()))
          throw new OperationStopped("Maintenance Ticket changed after merge");
        await tracker.closeTicket(repository, ticket);
        const closed = await completion();
        if (closed.state !== "closed")
          throw new Error("Issue closure has not been confirmed");
        return closed;
      },
      {
        reconcile: async () => {
          const observed = await completion();
          return observed.state === "closed"
            ? { outcome: "completed", result: observed }
            : { outcome: "pending" };
        },
      },
    );
  }
  publication.closure = { state: "closed", stateReason: "completed" };
  publication.deliveryLabels = [...current.labels];
  publication.phase = "delivered";
  await persist();
  return {
    outcome: "succeeded",
    reason: `Issue #${ticket} delivered by confirmed squash integration ${pullRequest.url} and closed/completed tracker state`,
  };
}

export async function integrateBatch(input: {
  batch: number[];
  ready: Map<
    number,
    { pullRequest: number; complete: () => Promise<RunSummary> }
  >;
  results: RunSummary[];
  repository: string;
  codeHost: CodeHost;
  read: ReadOperation;
}): Promise<RunSummary[]> {
  const { batch, ready, results, repository, codeHost, read } = input;
  if (
    batch.some(
      (number, index) =>
        !ready.has(number) &&
        results[index]!.outcome !== "no_work" &&
        results[index]!.outcome !== "succeeded",
    )
  )
    return results;
  const ordered = await Promise.all(
    [...ready].map(async ([number, integration]) => {
      const observed = await read("integration_order", `ticket:${number}`, () =>
        codeHost.getPullRequest(repository, integration.pullRequest),
      );
      return {
        number,
        ...integration,
        createdAt: Date.parse(observed.createdAt),
      };
    }),
  );
  ordered.sort(
    (a, b) => a.createdAt - b.createdAt || a.pullRequest - b.pullRequest,
  );
  for (const integration of ordered) {
    const index = batch.indexOf(integration.number);
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
