import { publishedHead, verifiedPublication } from "./publication-evidence.ts";
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
  beforeDispatch: () => Promise<boolean>;
  continuePublication: () => Promise<string>;
  restarting: boolean;
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
  let latest: Awaited<ReturnType<CodeHost["observeDelivery"]>> | undefined;
  const observe = () =>
    read("confirm_merge", target, async () => {
      const observed = await codeHost.observeDelivery({
        repository,
        pullRequest: pullRequest.number,
        ticket,
      });
      const candidate = observed.pullRequest;
      if (
        candidate.id !== pullRequest.id ||
        candidate.number !== pullRequest.number ||
        candidate.url !== pullRequest.url ||
        candidate.branch !== pullRequest.branch ||
        candidate.targetBranch !== pullRequest.targetBranch ||
        candidate.createdAt !== pullRequest.createdAt ||
        candidate.headSha !== head ||
        candidate.draft ||
        observed.state.headSha !== head ||
        observed.state.merged !== (candidate.state === "merged") ||
        !observed.ticket.id ||
        !Array.isArray(observed.ticket.labels) ||
        observed.ticket.number !== ticket ||
        observed.ticket.repositoryId !== publication.repositoryId ||
        observed.ticket.repository?.toLowerCase() !== repository.toLowerCase()
      )
        throw new Error(
          "Pull Request or Issue identity changed before integration confirmation",
        );
      latest = observed;
      return observed;
    });
  const repair = async (reason: string) => {
    publication.conflict ??= reason;
    publication.phase = "conflict_repair";
    delete publication.mergeDeadline;
    await persist();
    await input.continuePublication();
    head = publishedHead(publication);
  };
  const sleep = async (ms: number) => {
    context.signal?.throwIfAborted();
    await context.clock.sleep(ms);
    context.signal?.throwIfAborted();
  };
  if (publication.phase === "conflict_repair") {
    await input.continuePublication();
    head = publishedHead(publication);
  }
  if (publication.phase !== "merged" && publication.phase !== "delivered") {
    let state =
      !input.restarting &&
      publication.phase === "checks_ready" &&
      publication.ci
        ? publication.ci
        : (await observe()).state;
    for (;;) {
      if (state.merged) {
        publication.merge = state;
        publication.phase = "merged";
        await persist();
        break;
      }
      if (
        progress.purpose === "documentation" &&
        !(await input.beforeDispatch())
      )
        throw new OperationStopped(
          "Maintenance Ticket changed before integration",
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
          state = (await observe()).state;
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
          state = publication.ci ?? (await observe()).state;
          continue;
        }
      }
      if (!state.mergeRequested && state.mergeable === "conflicting") {
        await repair(
          publication.conflict ?? "Pull Request has an explicit merge conflict",
        );
        state = (await observe()).state;
        continue;
      }
      if (state.mergeFailure !== null) {
        await pauseForOperator(
          context.operator,
          state.mergeFailure,
          context.signal,
        );
        state = (await observe()).state;
        continue;
      }
      if (!state.mergeRequested && publication.phase !== "merge_requested") {
        publication.phase = "pending_merge";
        await persist();
        let attempted = false;
        const request = await read(
          "request_squash_merge",
          target,
          async () => {
            if (attempted) state = (await observe()).state;
            attempted = true;
            if (state.merged || state.mergeRequested)
              return { outcome: "accepted" as const };
            if (
              progress.purpose === "documentation" &&
              !(await input.beforeDispatch())
            )
              throw new OperationStopped(
                "Maintenance Ticket changed before merge request",
              );
            if (state.mergeable === "conflicting")
              return {
                outcome: "conflict" as const,
                error: new Error("Pull Request has an explicit merge conflict"),
              };
            if (state.mergeFailure !== null)
              throw new Error(state.mergeFailure);
            if (state.mergeStateStatus === "DIRTY")
              return {
                outcome: "conflict" as const,
                error: new Error("Pull Request has an explicit merge conflict"),
              };
            if (
              !state.isMergeQueueEnabled &&
              !loaded.config.codeHost.adminMerge &&
              ["BLOCKED", "BEHIND"].includes(state.mergeStateStatus ?? "")
            )
              throw new Error(
                `Pull Request merge is ${state.mergeStateStatus}`,
              );
            const result = await codeHost.requestSquashMerge({
              repository,
              pullRequest: pullRequest.number,
              pullRequestId: pullRequest.id,
              headSha: head,
              admin: loaded.config.codeHost.adminMerge,
              queue: state.isMergeQueueEnabled === true,
            });
            if (result.outcome === "rejected") throw result.error;
            return result;
          },
          {
            reconcile: async () => {
              state = (await observe()).state;
              if (state.merged || state.mergeRequested)
                return {
                  outcome: "completed",
                  result: { outcome: "accepted" as const },
                };
              if (
                state.mergeable === "conflicting" ||
                state.mergeStateStatus === "DIRTY"
              )
                return {
                  outcome: "completed",
                  result: {
                    outcome: "conflict" as const,
                    error: new Error(
                      "Pull Request has an explicit merge conflict",
                    ),
                  },
                };
              return { outcome: "pending" };
            },
          },
        );
        if (request.outcome === "conflict") {
          state = (await observe()).state;
          if (state.merged || state.mergeRequested) continue;
          await repair(
            request.error instanceof Error
              ? request.error.message
              : String(request.error),
          );
          state = (await observe()).state;
          continue;
        }
      }
      publication.phase = "merge_requested";
      publication.mergeDeadline ??=
        context.clock.now().getTime() +
        loaded.config.timeouts.mergeQueueMinutes * 60_000;
      await persist();
      for (;;) {
        state = (await observe()).state;
        if (state.merged) break;
        if (
          progress.purpose === "documentation" &&
          !(await input.beforeDispatch())
        )
          throw new OperationStopped(
            "Maintenance Ticket changed while awaiting integration",
          );
        if (!state.mergeRequested && state.mergeable === "conflicting") {
          await repair("Pull Request has an explicit merge conflict");
          state = (await observe()).state;
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
          state = (await observe()).state;
          break;
        }
        await sleep(Math.min(10_000, remaining));
      }
    }
  }
  if (!publication.merge?.merged || publication.merge.headSha !== head)
    throw new Error("Delivery requires persisted merge confirmation");
  if (publication.phase === "delivered") {
    if (
      publication.closure?.state !== "closed" ||
      publication.closure.stateReason !== "completed" ||
      !Array.isArray(publication.deliveryLabels)
    )
      throw new Error(
        "Delivery requires persisted completed tracker state and labels",
      );
    const observation = await observe();
    if (!observation.state.merged)
      throw new OperationStopped(
        "Previously delivered Pull Request is no longer merged",
      );
    const current = observation.ticket;
    if (current.state !== "closed" || current.stateReason !== "completed")
      throw new OperationStopped(
        "Previously delivered Issue is no longer closed/completed; retained delivery evidence",
      );
    return {
      outcome: "succeeded",
      reason: `Issue #${ticket} delivered by confirmed squash integration ${pullRequest.url} and closed/completed tracker state`,
    };
  }
  const completion = async () => {
    const observed = latest ?? (await observe());
    latest = undefined;
    if (!observed.state.merged)
      throw new Error("Delivery requires confirmed merged Pull Request");
    const current = observed.ticket;
    if (current.state === "closed") {
      if (current.stateReason !== "completed")
        throw new OperationStopped(
          "Issue was cancelled after merge; no delivery credit",
        );
    }
    if (
      current.state === "open" &&
      progress.purpose === "documentation" &&
      !(await input.beforeDispatch())
    )
      throw new OperationStopped("Maintenance Ticket changed after merge");
    return current;
  };
  for (;;) {
    let current = await completion();
    if (current.state !== "closed") {
      await read(
        "close_ticket",
        target,
        async () => {
          if ((await completion()).state === "closed") return;
          await tracker.closeTicket(repository, ticket);
          if ((await completion()).state !== "closed")
            throw new Error("Issue closure has not been confirmed");
        },
        {
          reconcile: async () =>
            (await completion()).state === "closed"
              ? { outcome: "completed", result: undefined }
              : { outcome: "pending" },
        },
      );
      current = await completion();
    }
    if (current.state === "closed") {
      publication.closure = { state: "closed", stateReason: "completed" };
      if (!Array.isArray(current.labels))
        throw new Error("Delivery requires observed Issue labels");
      publication.deliveryLabels = [...current.labels];
      publication.phase = "delivered";
      await persist();
      return {
        outcome: "succeeded",
        reason: `Issue #${ticket} delivered by confirmed squash integration ${pullRequest.url} and closed/completed tracker state`,
      };
    }
    await pauseForOperator(
      context.operator,
      `Merged Issue ${ticket} is not closed as completed.`,
      context.signal,
    );
  }
}

export async function integrateBatch(input: {
  batch: number[];
  ready: Map<
    number,
    {
      pullRequest: { number: number; createdAt: string };
      complete: () => Promise<RunSummary>;
    }
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
  const ordered = [...ready].map(([number, integration]) => ({
    number,
    ...integration,
  }));
  ordered.sort(
    (a, b) =>
      Date.parse(a.pullRequest.createdAt) -
        Date.parse(b.pullRequest.createdAt) ||
      a.pullRequest.number - b.pullRequest.number,
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
  beforeDispatch: () => Promise<boolean>;
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
        if (selected.reason || !(await input.beforeDispatch()))
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
