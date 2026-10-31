import type { Ticket } from "./contracts.ts";
import type { RunOptions, RunSummary } from "./run.ts";
import { selectIssueBatch } from "./discovery.ts";
import { integrateBatch } from "./integration.ts";
import { runStandalone } from "./standalone.ts";
import { TicketSkipped } from "./operations.ts";

export async function runBatch(
  input: Omit<Parameters<typeof runStandalone>[0], "number"> & {
    options: RunOptions;
    tickets: Ticket[];
    selection?: Awaited<ReturnType<typeof selectIssueBatch>>;
    controller: AbortController;
    document: (batch: string, runId: string) => Promise<RunSummary>;
  },
): Promise<RunSummary> {
  const {
    tickets,
    loaded,
    tracker,
    context,
    read,
    summary,
    codeHost,
    fetchBase,
    options,
    controller,
    document,
  } = input;
  let { selection } = input;
  const trigger = loaded.config.workflow.docMaintainTriggerLabel;
  selection ??= await selectIssueBatch({
    ...input,
    targetBranch: summary.targetBranch,
    ...(options.issueTicket !== undefined
      ? { issueTicket: options.issueTicket }
      : {}),
  });
  if (selection.documentation) {
    const result = await document(selection.documentation, selection.runId);
    if (result.outcome === "succeeded") await selection.complete();
    return result;
  }
  const reasons = [...selection.reasons];
  let needsDocumentation = false;
  const integrations = new Map<
    number,
    { pullRequest: number; complete: () => Promise<RunSummary> }
  >();
  let delivered: number[] = [];
  let resolved: boolean;
  const attempts = selection.batch.map(async (number) => {
    try {
      context.signal?.throwIfAborted();
      return await runStandalone({
        number,
        ...(options.selector === "parent"
          ? { parentTicket: summary.parentTicket }
          : {}),
        loaded,
        tracker,
        context: { ...context, runId: selection.runId },
        summary,
        read,
        fetchBase,
        codeHost,
        autoMerge: options.autoMerge,
        onDelivery: (labels) => {
          needsDocumentation ||= Boolean(trigger && labels.includes(trigger));
        },
        deferIntegration: (pullRequest, complete) => {
          integrations.set(number, { pullRequest, complete });
        },
      });
    } catch (error) {
      if (error instanceof TicketSkipped)
        return { ...summary, reasons: [error.message] };
      controller.abort(error);
      throw error;
    }
  });
  try {
    const results = await integrateBatch({
      batch: selection.batch,
      ready: integrations,
      results: await Promise.all(attempts),
      repository: loaded.config.repository,
      codeHost,
      read,
    });
    resolved = results.every(
      (result) =>
        result.outcome === "succeeded" || result.outcome === "no_work",
    );
    delivered = selection.batch.filter(
      (_number, index) => results[index]!.outcome === "succeeded",
    );
    for (const [index, result] of results.entries())
      reasons.push(
        ...result.reasons.map(
          (reason) => `Issue #${selection.batch[index]!}: ${reason}`,
        ),
      );
    if (resolved && needsDocumentation) {
      const maintenance = await document(
        await selection.scheduleDocumentation(),
        selection.runId,
      );
      reasons.push(...maintenance.reasons);
      if (maintenance.outcome !== "succeeded") return { ...summary, reasons };
    }
    if (selection.batch.length > 0 && resolved) await selection.complete();
  } catch (error) {
    await Promise.allSettled(attempts);
    throw error;
  }
  return {
    ...summary,
    outcome:
      (selection.batch.length === 0 && tickets.length === 0) ||
      (options.selector === "issue" &&
        tickets.every((ticket) => ticket.state === "closed"))
        ? "no_work"
        : (options.selector === "parent" &&
              selection.batch.length > 0 &&
              resolved) ||
            (options.selector === "issue" &&
              tickets.every(
                (ticket) =>
                  ticket.state === "closed" ||
                  delivered.includes(ticket.number),
              ))
          ? "succeeded"
          : "incomplete",
    reasons: [
      ...(selection.batch.length
        ? [`selected Delivery Tickets: ${selection.batch.join(", ")}`]
        : []),
      ...reasons,
    ],
  };
}
