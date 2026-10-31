import path from "node:path";
import { rename } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { nonempty, object, readHandoff } from "../agent/handoff.ts";
import { saveProgress, type MaintenanceProgress } from "../recovery.ts";
import { runStandalone } from "./standalone.ts";
import {
  OperationStopped,
  pauseForOperator,
  scopeOperator,
  TicketSkipped,
} from "./operations.ts";
import type { Tracker } from "./contracts.ts";
import type { RunSummary } from "./run.ts";
import {
  recoveringRead,
  restartUnrecoverable,
  restoreExecution,
} from "./execution-recovery.ts";
import { cleanupExecution } from "./cleanup.ts";
import { reportTicket } from "./report.ts";

export async function runDocumentation(
  input: Omit<Parameters<typeof runStandalone>[0], "number"> & {
    batch?: string;
  },
): Promise<RunSummary> {
  const { loaded, tracker, summary } = input;
  const context = {
    ...input.context,
    operator: scopeOperator(
      input.context.operator,
      "the current Documentation Maintenance occurrence",
    ),
  };
  const read: typeof input.read = (operation, target, action, settings) =>
    input.read(operation, target, action, {
      operator: context.operator,
      ...settings,
    });
  const file = path.join(
    loaded.directory,
    "recovery",
    `${context.inputHash}-document${input.batch ? `-batch-${input.batch}` : ""}.json`,
  );
  context.retained?.set(file, undefined);
  const previous = await readHandoff(file);
  let maintenance: MaintenanceProgress = {
    run_id: context.runId,
    input_hash: context.inputHash,
    run_arguments: context.runArguments,
    repository: loaded.config.repository,
    target_branch: summary.targetBranch,
    phase: "scheduled",
    ...(input.batch ? { batch: input.batch } : {}),
  };
  const persist = () =>
    context.signal?.aborted
      ? saveProgress(file, maintenance)
      : read("save_maintenance_checkpoint", "document", () =>
          saveProgress(file, maintenance),
        );
  try {
    if (previous) {
      let saved: Record<string, unknown>;
      try {
        saved = object(JSON.parse(previous.text) as unknown);
      } catch (error) {
        throw new Error(
          "unable to recover: invalid documentation maintenance checkpoint",
          { cause: error },
        );
      }
      if (
        saved.input_hash !== context.inputHash ||
        JSON.stringify(saved.run_arguments) !==
          JSON.stringify(context.runArguments) ||
        saved.repository !== maintenance.repository ||
        saved.target_branch !== maintenance.target_branch ||
        saved.batch !== input.batch ||
        (input.batch !== undefined && saved.run_id !== context.runId) ||
        !nonempty(saved.run_id) ||
        ![
          "scheduled",
          "ticket_created",
          "delivered",
          "completed",
          "skipped",
        ].includes(String(saved.phase)) ||
        (saved.ticket !== undefined &&
          (!Number.isSafeInteger(saved.ticket) ||
            (saved.ticket as number) <= 0)) ||
        (saved.phase !== "scheduled" &&
          saved.phase !== "skipped" &&
          saved.ticket === undefined) ||
        (saved.creationAttempted !== undefined &&
          saved.creationAttempted !== true)
      )
        throw new Error(
          "unable to recover: invalid documentation maintenance checkpoint",
        );
      if (saved.phase === "completed" && input.batch)
        return {
          ...summary,
          outcome: "succeeded",
          reasons: [`Completed Maintenance Ticket ${String(saved.ticket)}`],
        };
      if (
        saved.phase !== "completed" &&
        (saved.phase !== "skipped" || input.batch)
      )
        maintenance = saved as unknown as MaintenanceProgress;
    }
    context.runId = maintenance.run_id;
    if (maintenance.ticket === undefined) {
      const label = loaded.config.maintenanceTicket.label;
      const labelExists = async () => {
        let page: number | null = 1;
        const visited = new Set<number>();
        while (page !== null) {
          if (visited.has(page))
            throw new Error("Repeated maintenance label page");
          visited.add(page);
          const current: number = page;
          const result: Awaited<ReturnType<Tracker["listLabelsPage"]>> =
            await read("read_maintenance_labels", `page:${page}`, () =>
              tracker.listLabelsPage(maintenance.repository, current),
            );
          if (result.labels.includes(label)) return true;
          page = result.nextPage;
        }
        return false;
      };
      if (!(await labelExists()))
        await read(
          "create_maintenance_label",
          label,
          () => tracker.createLabel(maintenance.repository, label),
          {
            reconcile: async () =>
              (await labelExists())
                ? { outcome: "completed", result: undefined }
                : { outcome: "pending" },
          },
        );
      await persist();
      await read(
        "create_maintenance_ticket",
        "document",
        async () => {
          if (maintenance.creationAttempted)
            await pauseForOperator(
              context.operator,
              "Maintenance Ticket creation outcome is uncertain. Inspect remote state before authorizing another creation; unrelated old occurrences are never adopted.",
              context.signal,
              true,
            );
          maintenance.creationAttempted = true;
          await persist();
          context.signal?.throwIfAborted();
          const ticket = await tracker.createMaintenanceTicket(
            maintenance.repository,
            loaded.config.maintenanceTicket.title,
            loaded.config.maintenanceTicket.body,
            label,
          );
          if (
            !Number.isSafeInteger(ticket.number) ||
            ticket.number <= 0 ||
            ticket.state !== "open" ||
            ticket.assignees?.length ||
            !ticket.labels?.includes(label) ||
            ticket.labels.includes(loaded.config.tracker.reservationLabel) ||
            (ticket.repository !== undefined &&
              ticket.repository !== maintenance.repository)
          )
            throw new Error(
              "Created Maintenance Ticket is not standalone and labelled",
            );
          maintenance.ticket = ticket.number;
          maintenance.phase = "ticket_created";
          await persist();
        },
        { retry: "manual" },
      );
    }
    const recoveredDelivery = maintenance.phase === "delivered";
    const result = recoveredDelivery
      ? {
          ...summary,
          outcome: "succeeded" as const,
          reasons: [`Completed Maintenance Ticket ${maintenance.ticket}`],
        }
      : await runStandalone({
          ...input,
          context,
          read,
          number: maintenance.ticket!,
          documentation: true,
        });
    if (result.outcome !== "succeeded")
      return {
        ...result,
        outcome: result.outcome === "no_work" ? "incomplete" : result.outcome,
      };
    maintenance.phase = "delivered";
    await persist();
    const executionFile = path.join(
      loaded.directory,
      "recovery",
      `${context.inputHash}-document-${maintenance.ticket}.json`,
    );
    context.retained?.set(executionFile, undefined);
    const progress = await restoreExecution({
      file: executionFile,
      loaded,
      project: summary.project,
      number: maintenance.ticket!,
      repository: maintenance.repository,
      targetBranch: summary.targetBranch,
      documentation: true,
      runId: maintenance.run_id,
      inputHash: context.inputHash,
      runArguments: context.runArguments,
    });
    if (!progress)
      throw new Error("Missing owned documentation execution for cleanup");
    context.retained?.set(executionFile, progress);
    if (recoveredDelivery)
      await reportTicket(
        { ...input, context, number: maintenance.ticket!, documentation: true },
        () => Promise.resolve(result),
      );
    const persistExecution = () =>
      context.signal?.aborted
        ? saveProgress(executionFile, progress)
        : read(
            "save_implementation_checkpoint",
            `ticket:${maintenance.ticket}`,
            () => saveProgress(executionFile, progress),
          );
    await cleanupExecution({
      progress,
      loaded,
      git: context.git,
      read: recoveringRead({
        read,
        current: () => progress,
        persist: persistExecution,
        operator: context.operator,
      }),
      persist: persistExecution,
    });
    maintenance.phase = "completed";
    await persist();
    return result;
  } catch (error) {
    if (
      error instanceof Error &&
      error.message.startsWith("unable to recover")
    ) {
      await restartUnrecoverable(
        context.operator,
        "Documentation Maintenance occurrence",
        context.signal,
      );
      const archive = `${file}.${randomUUID()}.retained`;
      await read("retain_unrecoverable_documentation", "document", () =>
        rename(file, archive),
      );
      context.retained?.set(archive, undefined);
      return runDocumentation({
        ...input,
        context: {
          ...input.context,
          runId: input.batch ? input.context.runId : randomUUID(),
        },
      });
    }
    if (!(error instanceof TicketSkipped || error instanceof OperationStopped))
      throw error;
    if (error instanceof TicketSkipped) {
      maintenance.phase = "skipped";
      await persist();
    }
    return { ...summary, reasons: [error.message] };
  }
}
