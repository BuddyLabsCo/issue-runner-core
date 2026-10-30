import { mkdir, rename, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import path from "node:path";
import type { CommitEvidence } from "./run/contracts.ts";

export function hashRunInput(
  argv: readonly string[],
  config: Uint8Array,
): string {
  return createHash("sha256")
    .update(JSON.stringify(argv))
    .update(config)
    .digest("hex");
}

export interface ExecutionResult {
  outcome: "committed" | "no_change";
  summary: string;
  commits: CommitEvidence[];
  findings_file: null;
}

export interface Invocation {
  invocation_id: string;
  path: string;
}

export interface ImplementationProgress {
  run_id: string;
  execution_id: string;
  project: string;
  repository: string;
  ticket: number;
  target_branch: string;
  worktree: string;
  branch: string;
  base: string;
  phase:
    | "reserved"
    | "worktree_created"
    | "probing"
    | "implementing"
    | "implementation_completed";
  probe?: {
    probe_id: string;
    path: string;
  };
  roles: Partial<Record<"implement" | "review", { sessionid: string }>>;
  pr_title?: string;
  pr_body?: string;
  invocation?: Invocation;
  pendingPrompt?: string;
  result?: ExecutionResult;
  corrections: number;
  probeRetries?: number;
  probeIds?: string[];
  superseded: string[];
}

export async function saveProgress(
  file: string,
  progress: ImplementationProgress,
): Promise<void> {
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(`${file}.tmp`, `${JSON.stringify(progress, null, 2)}\n`);
  await rename(`${file}.tmp`, file);
}
