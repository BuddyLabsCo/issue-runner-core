import path from "node:path";
import { randomUUID } from "node:crypto";
import type { LoadedProject } from "../config.ts";
import { nonempty, object, readHandoff } from "../agent/handoff.ts";
import { saveProgress, type BatchProgress } from "../recovery.ts";
import type { ChildPage, Ticket, Tracker } from "./contracts.ts";
import type { OperationOptions } from "./operations.ts";
import type { RunContext } from "./run.ts";

export type ReadOperation = <T>(
  operation: string,
  target: string,
  action: () => Promise<T>,
  options?: OperationOptions<T>,
) => Promise<T>;

export async function readChildren(
  repository: string,
  parent: number,
  tracker: Tracker,
  read: ReadOperation,
): Promise<Ticket[]> {
  const children: Ticket[] = [];
  let page: number | null = 1;
  const pages = new Set<number>();
  while (page !== null) {
    if (!Number.isSafeInteger(page) || page <= 0 || pages.has(page))
      throw new Error("invalid child pagination");
    pages.add(page);
    const currentPage: number = page;
    const current: ChildPage = await read(
      "read_children",
      `parent:${parent}:page:${page}`,
      () => tracker.listChildrenPage(repository, parent, currentPage),
    );
    children.push(...current.children);
    page = current.nextPage;
  }
  const foreignChild = children.find(
    (child) => child.repository !== repository,
  );
  if (foreignChild)
    throw new Error(
      `cross-repository child ${foreignChild.repository}#${foreignChild.number} is unsupported`,
    );
  return children;
}

export async function hasOpenBlocker(
  repository: string,
  number: number,
  tracker: Tracker,
  read: ReadOperation,
): Promise<boolean> {
  let blocked = false;
  let page: number | null = 1;
  const pages = new Set<number>();
  while (page !== null) {
    if (!Number.isSafeInteger(page) || page <= 0 || pages.has(page))
      throw new Error("invalid blocker pagination");
    pages.add(page);
    const currentPage: number = page;
    const current: Awaited<ReturnType<Tracker["listBlockersPage"]>> =
      await read("read_blockers", `ticket:${number}:page:${page}`, () =>
        tracker.listBlockersPage(repository, number, currentPage),
      );
    for (const blocker of current.blockers) {
      if (blocker.state === "closed" && blocker.stateReason === null)
        throw new Error(
          `blocker ${blocker.number} has an unsupported terminal state`,
        );
      if (blocker.state === "open") blocked = true;
    }
    page = current.nextPage;
  }
  return blocked;
}

function parseBatch(
  text: string,
  expected: Pick<
    BatchProgress,
    "input_hash" | "run_arguments" | "repository" | "target_branch"
  >,
  maxBatchSize: number,
): BatchProgress {
  const saved = object(JSON.parse(text) as unknown);
  if (
    Object.entries(expected).some(
      ([key, value]) => JSON.stringify(saved[key]) !== JSON.stringify(value),
    ) ||
    !nonempty(saved.run_id) ||
    (saved.completed !== undefined && typeof saved.completed !== "boolean") ||
    (saved.documentation !== undefined &&
      (typeof saved.documentation !== "string" ||
        !/^[0-9a-f-]{36}$/u.test(saved.documentation))) ||
    !Array.isArray(saved.tickets) ||
    saved.tickets.length === 0 ||
    saved.tickets.length > maxBatchSize ||
    !saved.tickets.every(
      (number: unknown, index: number, numbers: unknown[]) =>
        Number.isSafeInteger(number) &&
        (number as number) > 0 &&
        (index === 0 || (number as number) > (numbers[index - 1] as number)),
    )
  )
    throw new Error("unable to recover: invalid Batch checkpoint");
  return saved as unknown as BatchProgress;
}

export async function selectIssueBatch(input: {
  tickets: Ticket[];
  loaded: LoadedProject;
  tracker: Tracker;
  context: RunContext;
  read: ReadOperation;
  targetBranch: string;
  issueTicket?: number;
}): Promise<{
  batch: number[];
  runId: string;
  reasons: string[];
  documentation?: string;
  scheduleDocumentation: () => Promise<string>;
  complete: () => Promise<void>;
}> {
  const { tickets, loaded, tracker, context, read } = input;
  const config = loaded.config;
  const batchFile = path.join(
    loaded.directory,
    "recovery",
    `${context.inputHash}-batch.json`,
  );
  const previous = await read("read_batch_checkpoint", batchFile, () =>
    readHandoff(batchFile),
  );
  const ownership = {
    input_hash: context.inputHash,
    run_arguments: context.runArguments,
    repository: config.repository,
    target_branch: input.targetBranch,
  };
  const recorded = previous
    ? parseBatch(previous.text, ownership, config.maxBatchSize)
    : undefined;
  const eligible: Ticket[] = [];
  const blocked: number[] = [];
  const externallyOwned: number[] = [];
  const reservations: string[] = [];
  for (const child of [...tickets].sort((a, b) => a.number - b.number)) {
    const isBlocked = await hasOpenBlocker(
      config.repository,
      child.number,
      tracker,
      read,
    );
    if (child.state === "closed") {
      if (child.stateReason === null)
        throw new Error(
          `Delivery Ticket ${child.number} has an unsupported terminal state`,
        );
      continue;
    }
    const hasRunner =
      child.assignees?.includes(config.tracker.runnerAccount) ?? false;
    const hasLabel =
      child.labels?.includes(config.tracker.reservationLabel) ?? false;
    const external = child.assignees?.some(
      (account) => account !== config.tracker.runnerAccount,
    );
    if (external) externallyOwned.push(child.number);
    if (isBlocked) blocked.push(child.number);
    if (hasRunner || hasLabel)
      reservations.push(
        `${child.number} (${hasRunner && hasLabel ? "complete" : "partial"})`,
      );
    if (
      external ||
      isBlocked ||
      !child.labels?.includes("ready-for-agent") ||
      (config.issueList.length > 0 &&
        input.issueTicket === undefined &&
        !config.issueList.includes(child.number)) ||
      hasRunner !== hasLabel
    )
      continue;
    if (
      hasRunner &&
      !(await readHandoff(
        path.join(
          loaded.directory,
          "recovery",
          `${context.inputHash}-${child.number}.json`,
        ),
      ))
    )
      continue;
    eligible.push(child);
  }
  const missing = config.issueList.filter(
    (number) => !tickets.some((child) => child.number === number),
  );
  const batch =
    (recorded && !recorded.completed ? recorded.tickets : undefined) ??
    [...new Set(eligible.map((ticket) => ticket.number))].slice(
      0,
      config.maxBatchSize,
    );
  const progress: BatchProgress = {
    run_id: recorded?.run_id ?? context.runId,
    ...ownership,
    tickets: batch,
    ...(recorded && !recorded.completed && recorded.documentation
      ? { documentation: recorded.documentation }
      : {}),
  };
  if ((!recorded || recorded.completed) && batch.length > 0)
    await read("save_batch_checkpoint", batchFile, () =>
      saveProgress(batchFile, progress),
    );
  return {
    batch,
    runId: recorded?.run_id ?? context.runId,
    ...(progress.documentation
      ? { documentation: progress.documentation }
      : {}),
    scheduleDocumentation: async () => {
      progress.documentation ??= randomUUID();
      await read("schedule_batch_documentation", batchFile, () =>
        saveProgress(batchFile, progress),
      );
      return progress.documentation;
    },
    complete: () =>
      read("complete_batch_checkpoint", batchFile, () =>
        saveProgress(batchFile, { ...progress, completed: true }),
      ),
    reasons: [
      ...(blocked.length
        ? [`blocked Delivery Tickets: ${blocked.join(", ")}`]
        : []),
      ...(externallyOwned.length
        ? [`externally owned Delivery Tickets: ${externallyOwned.join(", ")}`]
        : []),
      ...(reservations.length
        ? [`existing Reservations: ${reservations.join(", ")}`]
        : []),
      ...(missing.length
        ? [`configured Delivery Tickets not found: ${missing.join(", ")}`]
        : []),
    ],
  };
}
