import path from "node:path";
import { randomUUID } from "node:crypto";
import type { LoadedProject } from "../config.ts";
import { nonempty, object, readHandoff } from "../agent/handoff.ts";
import {
  checkpointVersion,
  sameRepositoryName,
  saveProgress,
  type BatchProgress,
} from "../recovery.ts";
import type { ChildPage, Ticket, Tracker } from "./contracts.ts";
import { OperationStopped, type OperationOptions } from "./operations.ts";
import type { RunContext } from "./run.ts";
import type { RunScope } from "./scope.ts";
import { viewerOf } from "./viewer.ts";

export type ReadOperation = <T>(
  operation: string,
  target: string,
  action: () => Promise<T>,
  options?: OperationOptions<T> & { phase?: string },
) => Promise<T>;

export type BatchTicket = Ticket & { blocked?: boolean };

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
  validateChildRepositories(repository, children);
  return children;
}

export function validateChildRepositories(
  repository: string,
  children: (Pick<Ticket, "repository" | "number"> & {
    repositoryId?: string;
  })[],
  repositoryId?: string,
): void {
  const foreignChild = children.find(
    (child) =>
      child.repository?.toLowerCase() !== repository.toLowerCase() ||
      (repositoryId !== undefined && child.repositoryId !== repositoryId),
  );
  if (foreignChild)
    throw new OperationStopped(
      `cross-repository child ${foreignChild.repository}#${foreignChild.number} is unsupported`,
    );
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
  expected: {
    inputHash: string;
    scope: RunScope;
    repository: string;
    targetBranch: string;
  },
): BatchProgress {
  const saved = object(JSON.parse(text) as unknown);
  if (
    saved.checkpoint_version !== checkpointVersion ||
    JSON.stringify(saved.run_scope) !== JSON.stringify(expected.scope) ||
    saved.input_hash !== expected.inputHash ||
    !sameRepositoryName(saved.repository, expected.repository) ||
    saved.target_branch !== expected.targetBranch ||
    !nonempty(saved.run_id) ||
    (saved.completed !== undefined && typeof saved.completed !== "boolean") ||
    (saved.documentation !== undefined &&
      (typeof saved.documentation !== "string" ||
        !/^[0-9a-f-]{36}$/u.test(saved.documentation))) ||
    !Array.isArray(saved.tickets) ||
    saved.tickets.length === 0 ||
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

export async function eligibleIssueNumbers(input: {
  tickets: BatchTicket[] | undefined;
  loaded: LoadedProject;
  tracker: Tracker;
  context: RunContext;
  read: ReadOperation;
  issueTicket?: number;
}): Promise<number[]> {
  const { tickets, loaded, tracker, context, read } = input;
  const config = loaded.config;
  const ordered = [...(tickets ?? [])].sort((a, b) => a.number - b.number);
  if (ordered.length === 0) return [];
  const viewerLogin = (await viewerOf(context).read()).login.toLowerCase();
  const eligible: number[] = [];
  for (const child of ordered) {
    const isBlocked =
      child.blocked ??
      (await hasOpenBlocker(config.repository, child.number, tracker, read));
    if (child.state === "closed") {
      if (child.stateReason === null)
        throw new Error(
          `Delivery Ticket ${child.number} has an unsupported terminal state`,
        );
      continue;
    }
    const hasRunner =
      child.assignees?.some(
        (account) => account.toLowerCase() === viewerLogin,
      ) ?? false;
    const hasLabel =
      child.labels?.includes(config.tracker.reservationLabel) ?? false;
    const external = child.assignees?.some(
      (account) => account.toLowerCase() !== viewerLogin,
    );
    if (
      external ||
      isBlocked ||
      (config.issueLabel !== "" &&
        !child.labels?.includes(config.issueLabel)) ||
      (config.issueList.length > 0 &&
        input.issueTicket === undefined &&
        !config.issueList.includes(child.number)) ||
      (hasLabel && !hasRunner)
    )
      continue;
    if (
      hasLabel &&
      !(await readHandoff(
        path.join(
          loaded.directory,
          "recovery",
          `${context.inputHash}-${child.number}.json`,
        ),
      ))
    )
      continue;
    eligible.push(child.number);
  }
  return eligible;
}

export async function selectIssueBatch(
  input: Parameters<typeof eligibleIssueNumbers>[0] & {
    targetBranch: string;
    eligible?: number[];
  },
): Promise<{
  batch: number[];
  completedCheckpoint: boolean;
  runId: string;
  documentation?: string;
  scheduleDocumentation: () => Promise<string>;
  complete: () => Promise<void>;
}> {
  const { loaded, context, read } = input;
  const config = loaded.config;
  const batchFile = path.join(
    loaded.directory,
    "recovery",
    `${context.inputHash}-batch.json`,
  );
  const previous = await read("read_batch_checkpoint", batchFile, () =>
    readHandoff(batchFile),
  );
  const scope = context.scope;
  if (!scope) throw new Error("Batch checkpoint requires a Run scope");
  const ownership = {
    input_hash: context.inputHash,
    run_arguments: context.runArguments,
    repository: config.repository,
    target_branch: input.targetBranch,
  };
  const recorded = previous
    ? parseBatch(previous.text, {
        inputHash: context.inputHash,
        scope,
        repository: config.repository,
        targetBranch: input.targetBranch,
      })
    : undefined;
  const eligible = input.eligible ?? (await eligibleIssueNumbers(input));
  const batch =
    (recorded && !recorded.completed ? recorded.tickets : undefined) ??
    [...new Set(eligible)].slice(0, config.maxBatchSize);
  const progress: BatchProgress = {
    checkpoint_version: checkpointVersion,
    run_scope: scope,
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
    completedCheckpoint: recorded?.completed === true,
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
  };
}
