import assert from "node:assert/strict";
import path from "node:path";

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
