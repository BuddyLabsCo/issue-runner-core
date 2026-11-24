import type { AgentConfig, LoadedProject } from "../config.ts";
import type {
  ImplementationProgress,
  NativeSession,
  RepairProgress,
} from "../recovery.ts";
import { nonempty, object } from "./handoff.ts";

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

function sameNativeSession(
  saved: Record<string, unknown>,
  profile: AgentConfig,
  label: string,
): void {
  const sessionid = saved.sessionid;
  if (
    !nonempty(sessionid) ||
    !nonempty(saved.agent) ||
    !nonempty(saved.resume) ||
    saved.agent !== profile.agent ||
    saved.resume !== profile.resume.replaceAll("{sessionref}", () => sessionid)
  )
    throw new Error(
      `unable to recover: native ${label} conversation identity changed; restart to use the current Agent configuration`,
    );
}

export function validateNativeSessions(
  progress: ImplementationProgress,
  loaded: LoadedProject,
): void {
  for (const role of ["implement", "review", "documentation"] as const) {
    const saved = progress.roles[role];
    if (saved === undefined) continue;
    const profile = loaded.config.agents[role];
    if (profile === undefined)
      throw new Error(
        `unable to recover: native ${role} conversation identity changed; restart to use the current Agent configuration`,
      );
    sameNativeSession(object(saved), profile, role);
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
      if (saved.sessionid === undefined) continue;
      sameNativeSession(object(saved), profile, kind);
    }
  }
}
