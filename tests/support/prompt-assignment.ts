import assert from "node:assert/strict";
import path from "node:path";

export function assertBusinessAssignment(
  submission: { expectedFile?: string; recoveryText?: string },
  file: string,
  name: string,
) {
  assert.equal(submission.expectedFile, file);
  assert.equal(path.isAbsolute(file), true);
  assert.equal(
    submission.recoveryText,
    `Continue unfinished work for the current ${name} assignment in this conversation. Preserve its scope and completion requirements.\n\nUse the issue-runner-handoff skill to report task completion or a pause requiring user action.\nHandoff path: ${JSON.stringify(file)}`,
  );
}

// Scripted agents read the same quoted output path as the real agent.
export function promptAssignment(text: string) {
  const quoted = [...text.matchAll(/"(?:[^"\\]|\\.)*"/gu)].at(-1)?.[0];
  assert.ok(quoted, "prompt must specify a JSON-quoted output path");
  const file = JSON.parse(quoted) as string;
  const name = path.basename(file);
  const ticket = Number(/^(\d+)-/u.exec(name)?.[1]);
  assert.ok(ticket > 0, "output path must belong to an Issue");
  const phase =
    /-(implement|documentation|review|ci_repair|conflict_repair)-probe-/u.exec(
      name,
    )?.[1];
  const role =
    phase === "ci_repair"
      ? "ciRepair"
      : phase === "conflict_repair"
        ? "conflictRepair"
        : phase;
  return { path: file, ticket, role };
}
