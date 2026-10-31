import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { lstat } from "node:fs/promises";
import path from "node:path";
import { runIssueStage, type IssueStageContext } from "../agent/stage.ts";
import {
  nonempty,
  object,
  parseExecution,
  readHandoff,
} from "../agent/handoff.ts";
import type {
  RepairProgress,
  ImplementationProgress,
  PublicationProgress,
} from "../recovery.ts";
import type { LoadedProject } from "../config.ts";
import { conflictRepairInstructions } from "../prompts/conflict-repair.ts";
import { ciRepairInstructions } from "../prompts/ci-repair.ts";
import type { GitWorkspace, WorkspaceEvidence } from "./contracts.ts";
import type { ReadOperation } from "./discovery.ts";
import { verifyWorkspace } from "./verification.ts";
import { OperationStopped, pauseForOperator } from "./operations.ts";

function validateRepairBudget(
  progress: ImplementationProgress,
  loaded: LoadedProject,
  kind: "ci" | "conflict",
): void {
  const budget =
    progress.publication?.[kind === "ci" ? "ciRepair" : "conflictRepair"];
  if (budget === undefined) return;
  const invalid = () =>
    new Error(
      `unable to recover: incomplete or invalid ${kind === "ci" ? "CI" : "conflict"} repair context`,
    );
  object(budget);
  if (
    !Number.isSafeInteger(budget.consumed) ||
    budget.consumed < 0 ||
    budget.consumed > 2 ||
    !Number.isSafeInteger(budget.generation) ||
    budget.generation < 0 ||
    !Array.isArray(budget.attempts) ||
    (budget.retryAuthorized !== undefined &&
      (budget.retryAuthorized !== true || budget.consumed !== 2)) ||
    !progress.publication?.pullRequest
  )
    throw invalid();
  const handoffs = path.join(loaded.directory, "handoffs");
  const owned = (value: unknown): value is string =>
    nonempty(value) &&
    path.isAbsolute(value) &&
    path.dirname(value) === handoffs;
  const ids = new Set<string>();
  const bases = new Set([
    progress.publication.headSha,
    ...pushedRepairs(progress.publication).map(
      (item) => item.result!.commits.at(-1)!.sha,
    ),
  ]);
  for (const [index, attempt] of budget.attempts.entries()) {
    object(attempt);
    const suffix = `ticket-${progress.ticket}-${kind}-repair-${attempt.attempt_id}`;
    if (
      !nonempty(attempt.attempt_id) ||
      ids.has(attempt.attempt_id) ||
      attempt.worktree !==
        path.join(loaded.directory, "worktrees", progress.run_id, suffix) ||
      attempt.branch !== `sandcastle/run-${progress.run_id}/${suffix}` ||
      !bases.has(attempt.base) ||
      (kind === "conflict" &&
        (!nonempty(attempt.targetBase) || !nonempty(attempt.conflict))) ||
      (kind === "ci" &&
        (attempt.targetBase !== undefined || attempt.conflict !== undefined)) ||
      !Array.isArray(attempt.failedChecks) ||
      attempt.failedChecks.some(
        (check) =>
          !nonempty(check.name) ||
          !nonempty(check.state) ||
          typeof check.link !== "string" ||
          !["fail", "cancel"].includes(check.bucket),
      ) ||
      !Number.isSafeInteger(attempt.generation) ||
      attempt.generation < 0 ||
      attempt.generation > budget.generation ||
      (index > 0 &&
        attempt.generation < budget.attempts[index - 1]!.generation) ||
      !Number.isSafeInteger(attempt.corrections) ||
      attempt.corrections < 0 ||
      !Array.isArray(attempt.superseded) ||
      !attempt.superseded.every(owned) ||
      (attempt.pendingPrompt !== undefined &&
        !nonempty(attempt.pendingPrompt)) ||
      (attempt.sessionid !== undefined && !nonempty(attempt.sessionid)) ||
      (attempt.verificationError !== undefined &&
        !nonempty(attempt.verificationError)) ||
      (attempt.probeRetries !== undefined &&
        (!Number.isSafeInteger(attempt.probeRetries) ||
          attempt.probeRetries < 0)) ||
      (attempt.probeIds !== undefined &&
        (!Array.isArray(attempt.probeIds) ||
          !attempt.probeIds.every(nonempty))) ||
      [attempt.worktreeCreated, attempt.counted, attempt.pushed].some(
        (value) => value !== undefined && value !== true,
      )
    )
      throw invalid();
    ids.add(attempt.attempt_id);
    for (const [key, id] of [
      ["probe", "probe_id"],
      ["invocation", "invocation_id"],
    ] as const) {
      if (attempt[key] !== undefined) {
        const assignment = object(attempt[key]);
        if (!nonempty(assignment[id]) || !owned(assignment.path))
          throw invalid();
      }
    }
    if (attempt.invocation && !attempt.sessionid) throw invalid();
    if (attempt.result) {
      parseExecution(JSON.stringify(attempt.result));
      if (!attempt.invocation || !attempt.worktreeCreated || !attempt.counted)
        throw invalid();
    } else if (attempt.counted || attempt.verificationError) throw invalid();
    if (attempt.pendingPush !== undefined || attempt.pushed) {
      if (
        attempt.result?.outcome !== "committed" ||
        attempt.verificationError ||
        (attempt.pendingPush !== undefined &&
          (attempt.pushed ||
            attempt.pendingPush !== attempt.result.commits.at(-1)?.sha))
      )
        throw invalid();
    }
    if (
      !attempt.pushed &&
      index < budget.attempts.length - 1 &&
      !attempt.verificationError &&
      attempt.result?.outcome !== "no_change"
    )
      throw invalid();
  }
  if (
    budget.consumed !==
    budget.attempts.filter(
      (attempt) => attempt.generation === budget.generation && attempt.counted,
    ).length
  )
    throw invalid();
}

export async function repairPullRequest(
  input: IssueStageContext & {
    kind: "ci" | "conflict";
    git: GitWorkspace;
    read: ReadOperation;
    confirm: (head?: string) => Promise<void>;
    remoteHead: () => Promise<string | null>;
  },
): Promise<void> {
  const { progress, read, git, kind } = input;
  const name = kind === "ci" ? "CI" : "Conflict";
  const publication = progress.publication!;
  const budget = (publication[kind === "ci" ? "ciRepair" : "conflictRepair"] ??=
    {
      consumed: 0,
      generation: 0,
      attempts: [],
    });
  if (budget.retryAuthorized) {
    budget.consumed = 0;
    budget.generation++;
    delete budget.retryAuthorized;
    await input.persist();
  }
  let attempt = budget.attempts.at(-1);
  if (
    !attempt ||
    attempt.pushed ||
    attempt.verificationError ||
    attempt.result?.outcome === "no_change"
  ) {
    if (budget.consumed >= 2) {
      await pauseForOperator(
        input.operator,
        `${name} repair failed after two attempts. Resolve ${kind === "ci" ? "checks" : "the conflict"}, then retry.`,
        input.signal,
        true,
      );
      budget.retryAuthorized = true;
      if (kind === "ci")
        publication.discoveryNotBefore = input.clock.now().getTime() + 30_000;
      else publication.phase = "pending_merge";
      delete publication.checksDeadline;
      await input.persist();
      return;
    }
    await input.confirm();
    const id = randomUUID();
    attempt = {
      attempt_id: id,
      generation: budget.generation,
      worktree: path.join(
        input.loaded.directory,
        "worktrees",
        progress.run_id,
        `ticket-${progress.ticket}-${kind}-repair-${id}`,
      ),
      branch: `sandcastle/run-${progress.run_id}/ticket-${progress.ticket}-${kind}-repair-${id}`,
      base:
        pushedRepairs(publication).at(-1)?.result?.commits.at(-1)?.sha ??
        publication.headSha,
      ...(kind === "conflict"
        ? {
            targetBase: await read(
              "fetch_conflict_target",
              `ticket:${progress.ticket}`,
              () =>
                git.fetchTargetBranch(
                  input.loaded.config.checkout,
                  publication.targetBranch,
                ),
            ),
            conflict: publication.conflict!,
          }
        : {}),
      corrections: 0,
      superseded: [],
      failedChecks: structuredClone(
        (publication.checks ?? []).filter(
          ({ bucket }) => bucket === "fail" || bucket === "cancel",
        ),
      ),
    };
    budget.attempts.push(attempt);
    await input.persist();
  }
  const repair: RepairProgress = attempt;
  if (!repair.worktreeCreated) {
    await input.confirm();
    await read(
      `create_${kind}_repair_worktree`,
      `ticket:${progress.ticket}`,
      async () => {
        let exists = false;
        try {
          const info = await lstat(repair.worktree);
          if (!info.isDirectory())
            throw new Error("Repair Worktree must be an owned directory");
          exists = true;
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
        }
        if (exists) {
          verifyWorkspace(repair, await git.inspect(repair), {
            outcome: "no_change",
            summary: "Unstarted repair",
            commits: [],
            findings_file: null,
          });
          return;
        }
        await git.createWorktree({
          checkout: input.loaded.config.checkout,
          worktree: repair.worktree,
          branch: repair.branch,
          base: repair.base,
        });
      },
      { retry: "manual" },
    );
    repair.worktreeCreated = true;
    await input.persist();
  } else if (!existsSync(repair.worktree))
    throw new Error(
      `unable to recover: original ${name} repair Worktree is missing`,
    );
  if (repair.probe && !repair.sessionid) {
    let probe;
    try {
      probe = await readHandoff(repair.probe.path);
    } catch (cause) {
      throw new Error(
        `unable to recover: invalid native ${name} repair Probe`,
        {
          cause,
        },
      );
    }
    if (!probe)
      throw new Error(
        `unable to recover: missing native ${name} repair identity`,
      );
  }
  const persist = async () => {
    if (repair.result && !repair.counted) {
      budget.consumed++;
      repair.counted = true;
    }
    await input.persist();
  };
  if (!repair.result)
    await runIssueStage({
      ...input,
      persist,
      stage: repair,
      purpose: kind === "ci" ? "ci_repair" : "conflict_repair",
      worktree: repair.worktree,
      task: () =>
        `${kind === "ci" ? ciRepairInstructions : conflictRepairInstructions}\n\nRepository: ${progress.repository}\nIssue #${progress.ticket}: ${input.ticket.title ?? ""}\n${input.ticket.body ?? ""}\nPR: ${publication.pullRequest!.url}\nWorktree: ${repair.worktree}\nDelivery branch: ${repair.branch}\nRemote branch: ${publication.branch}\nBase SHA: ${repair.base}\nTarget Branch: ${publication.targetBranch}\nFailed checks: ${JSON.stringify(repair.failedChecks)}${kind === "conflict" ? `\nTarget Branch SHA: ${repair.targetBase}\nMerge conflict: ${repair.conflict}` : ""}`,
      accept: async (text) => {
        const result = parseExecution(text);
        const { evidence, ancestry } = await read(
          `inspect_${kind}_repair`,
          `ticket:${progress.ticket}`,
          async () => ({
            evidence: await git.inspect(repair),
            ancestry: await inspectRepairAncestry(git, repair),
          }),
        );
        delete repair.verificationError;
        try {
          verifyWorkspace(repair, evidence, result);
          verifyRepairAncestry(repair, ancestry);
        } catch (error) {
          repair.verificationError =
            error instanceof Error ? error.message : String(error);
          input.operator.write(
            `${name} repair verification failed: ${repair.verificationError}; attempt consumed.`,
          );
        }
        return result;
      },
    });
  if (!repair.result)
    throw new OperationStopped(
      `Issue eligibility changed before ${name} repair dispatch`,
    );
  await persist();
  if (repair.verificationError || repair.result.outcome === "no_change") return;
  repair.pendingPush = repair.result.commits.at(-1)!.sha;
  await input.persist();
  await read(`push_${kind}_repair`, `ticket:${progress.ticket}`, async () => {
    verifyWorkspace(repair, await git.inspect(repair), repair.result!);
    verifyRepairAncestry(repair, await inspectRepairAncestry(git, repair));
    const remote = await input.remoteHead();
    if (remote === repair.pendingPush) {
      await input.confirm(repair.pendingPush);
      return;
    }
    await input.confirm();
    if (remote !== repair.base)
      throw new Error(
        "Stable repair branch advanced or disappeared; resolve remote state before retrying",
      );
    await git.push(repair.worktree, publication.branch, repair.pendingPush!);
    if ((await input.remoteHead()) !== repair.pendingPush)
      throw new Error(
        "Repair push has not been confirmed at the intended head",
      );
  });
  repair.pushed = true;
  delete repair.pendingPush;
  publication.phase = "pr_created";
  delete publication.conflict;
  delete publication.mergeDeadline;
  publication.discoveryNotBefore = input.clock.now().getTime() + 30_000;
  delete publication.checksDeadline;
  await input.persist();
}

export function validateRepairContext(
  progress: ImplementationProgress,
  loaded: LoadedProject,
): void {
  const publication = progress.publication;
  if (
    (publication?.conflict !== undefined && !nonempty(publication.conflict)) ||
    (publication?.phase === "conflict_repair" &&
      !nonempty(publication.conflict))
  )
    throw new Error("unable to recover: missing explicit conflict evidence");
  validateRepairBudget(progress, loaded, "ci");
  validateRepairBudget(progress, loaded, "conflict");
}

export function pushedRepairs(
  publication: PublicationProgress,
): RepairProgress[] {
  const remaining = [
    ...(publication.ciRepair?.attempts ?? []),
    ...(publication.conflictRepair?.attempts ?? []),
  ].filter((attempt) => attempt.pushed);
  const ordered: RepairProgress[] = [];
  let head = publication.headSha;
  while (remaining.length) {
    const matches = remaining.filter((attempt) => attempt.base === head);
    if (matches.length !== 1)
      throw new Error("unable to recover: invalid repair ancestry chain");
    const attempt = matches[0]!;
    head = parseExecution(JSON.stringify(attempt.result)).commits.at(-1)!.sha;
    ordered.push(attempt);
    remaining.splice(remaining.indexOf(attempt), 1);
  }
  return ordered;
}

export async function inspectRepairAncestry(
  git: GitWorkspace,
  repair: RepairProgress,
): Promise<WorkspaceEvidence | undefined> {
  if (repair.targetBase !== undefined) {
    return git.inspect({
      worktree: repair.worktree,
      base: repair.targetBase,
    });
  }
}

export function verifyRepairAncestry(
  repair: RepairProgress,
  evidence: WorkspaceEvidence | undefined,
): void {
  if (repair.targetBase !== undefined && evidence?.base !== repair.targetBase)
    throw new Error(
      "Conflict repair must include the fetched Target Branch SHA in its ancestry",
    );
}
