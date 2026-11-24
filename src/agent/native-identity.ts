import type { AgentConfig, LoadedProject } from "../config.ts";
import type {
  ImplementationProgress,
  NativeSession,
  RepairProgress,
} from "../recovery.ts";
import { nonempty, object, readHandoff } from "./handoff.ts";

type NativeRole = "implement" | "review" | "documentation";

export function nativeSession(
  profile: AgentConfig,
  sessionid: string,
): NativeSession {
  return {
    sessionid,
    agent: profile.agent,
    resume: profile.resume.replaceAll("{sessionref}", () => sessionid),
  };
}

function assertNativeSession(
  saved: Record<string, unknown>,
  profile: AgentConfig,
  label: string,
): void {
  const sessionid = saved.sessionid;
  const expected = nonempty(sessionid)
    ? nativeSession(profile, sessionid)
    : undefined;
  if (
    expected === undefined ||
    saved.agent !== expected.agent ||
    saved.resume !== expected.resume
  )
    throw new Error(
      `unable to recover: native ${label} conversation identity changed; restart to use the current Agent configuration`,
    );
}

function pendingFix(progress: ImplementationProgress): boolean {
  const noChange = progress.noChange;
  if (
    progress.result?.outcome === "no_change" &&
    noChange !== undefined &&
    noChange.delivery === undefined &&
    noChange.review?.result?.outcome === "findings" &&
    noChange.fix?.result === undefined
  )
    return true;
  return (progress.reviews ?? []).some(
    (round) =>
      round.result?.outcome === "findings" && round.fix?.result === undefined,
  );
}

function futureReview(
  progress: ImplementationProgress,
  loaded: LoadedProject,
): boolean {
  if (!loaded.config.workflow.review || progress.result === undefined)
    return false;
  if (progress.result.outcome === "no_change") {
    const noChange = progress.noChange;
    if (noChange?.delivery !== undefined) return false;
    if (noChange?.review?.result === undefined) return true;
    return noChange.review.result.outcome === "findings";
  }
  if (progress.publication !== undefined) return false;
  const reviews = progress.reviews;
  if (reviews === undefined || reviews.length === 0) return true;
  const last = reviews.at(-1)!;
  if (last.result === undefined) return true;
  if (last.result.outcome === "passed") return false;
  const max = loaded.config.workflow.maxReviewRounds;
  return max === undefined || last.round < max;
}

async function hasStageEvidence(
  stage: { probe?: { path: string }; invocation?: unknown } | undefined,
): Promise<boolean> {
  if (stage === undefined) return false;
  if (stage.invocation !== undefined) return true;
  if (stage.probe === undefined) return false;
  return (await readHandoff(stage.probe.path)) !== undefined;
}

async function hasNativeEvidence(
  progress: ImplementationProgress,
  role: NativeRole,
): Promise<boolean> {
  if (role === "documentation") return hasStageEvidence(progress);
  if (role === "review") {
    if (await hasStageEvidence(progress.noChange?.review)) return true;
    for (const round of progress.reviews ?? [])
      if (await hasStageEvidence(round)) return true;
    return false;
  }
  for (const stage of [
    progress,
    progress.noChange?.fix,
    ...(progress.reviews ?? []).map((round) => round.fix),
  ])
    if (await hasStageEvidence(stage)) return true;
  return false;
}

function resumableRoles(
  progress: ImplementationProgress,
  loaded: LoadedProject,
): Set<NativeRole> {
  const roles = new Set<NativeRole>();
  if (progress.purpose === "documentation") {
    if (progress.result === undefined) roles.add("documentation");
  } else {
    if (progress.result === undefined || pendingFix(progress))
      roles.add("implement");
    if (futureReview(progress, loaded)) {
      roles.add("implement");
      roles.add("review");
    }
  }
  return roles;
}

export async function validateNativeSessions(
  progress: ImplementationProgress,
  loaded: LoadedProject,
): Promise<void> {
  for (const role of resumableRoles(progress, loaded)) {
    const saved = progress.roles[role];
    const profile = loaded.config.agents[role];
    if (profile === undefined)
      throw new Error(
        `unable to recover: native ${role} conversation identity changed; restart to use the current Agent configuration`,
      );
    if (saved !== undefined) assertNativeSession(object(saved), profile, role);
    else if (await hasNativeEvidence(progress, role))
      throw new Error(
        `unable to recover: native ${role} conversation identity is missing; restart to use the current Agent configuration`,
      );
  }
  for (const [kind, attempts] of [
    ["CI repair", progress.publication?.ciRepair?.attempts],
    ["conflict repair", progress.publication?.conflictRepair?.attempts],
  ] as const) {
    const profile =
      loaded.config.agents[
        kind === "CI repair" ? "ciRepair" : "conflictRepair"
      ];
    for (const attempt of attempts ?? []) {
      const saved = object(attempt) as Partial<RepairProgress>;
      if (saved.result !== undefined) continue;
      if (saved.sessionid === undefined) {
        if (await hasStageEvidence(saved))
          throw new Error(
            `unable to recover: native ${kind} conversation identity is missing; restart to use the current Agent configuration`,
          );
        continue;
      }
      assertNativeSession(object(saved), profile, kind);
    }
  }
}
