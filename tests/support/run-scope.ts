/* eslint-disable @typescript-eslint/require-await -- Scripted external boundaries. */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile, readdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { parse, stringify } from "yaml";
import { executeCli } from "../../src/cli.ts";
import {
  committed,
  implementationCommand,
  implementationRun,
  publish,
} from "./implementation-run.ts";

export type ImplementationFixture = Awaited<
  ReturnType<typeof implementationRun>
>;
export type SavedProgress = Awaited<
  ReturnType<ImplementationFixture["snapshot"]>
>;

export function legacyRunInputHash(
  commandName: string,
  argv: readonly string[],
  config: Uint8Array,
): string {
  return createHash("sha256")
    .update(JSON.stringify([commandName, argv]))
    .update(config)
    .digest("hex");
}

export async function interrupt(fixture: ImplementationFixture) {
  fixture.state.onTask = async () => fixture.controller.abort();
  assert.equal((await fixture.run()).summary.outcome, "cancelled");
  const saved = await fixture.snapshot();
  fixture.dependencies.signal = new AbortController().signal;
  return saved;
}

export async function updateConfig(
  fixture: { directory: string },
  update: (config: Record<string, unknown>) => Record<string, unknown>,
) {
  const file = path.join(fixture.directory, "config.yaml");
  const config = parse(await readFile(file, "utf8")) as Record<string, unknown>;
  await writeFile(file, stringify(update(config)));
}

export function continueWith(
  fixture: ImplementationFixture,
  saved: SavedProgress,
) {
  const before = fixture.state.submissions.length;
  const submit = fixture.dependencies.terminalPlugin.onInput.bind(
    fixture.dependencies.terminalPlugin,
  );
  fixture.dependencies.terminalPlugin.onInput = async (tab, text, chord) => {
    await submit(tab, text, chord);
    if (text === "continue") {
      fixture.state.evidence.commits = committed().commits;
      await publish(saved.invocation!.path, committed());
    }
  };
  return before;
}

export async function assertRecovered(
  fixture: ImplementationFixture,
  saved: SavedProgress,
  command = implementationCommand,
) {
  const before = continueWith(fixture, saved);
  const result = await executeCli(command, fixture.dependencies);
  assert.match(result.summary.tickets![0]!.detail ?? "", /CI-ready/u);
  const current = await fixture.snapshot();
  assert.equal(current.execution_id, saved.execution_id);
  assert.deepEqual(
    fixture.state.submissions
      .slice(before)
      .map(({ text }) => text)
      .slice(0, 1),
    [`any-cli --resume "${saved.roles.implement!.sessionid}"`],
  );
  return current;
}

export function interruptNextAssignment(
  fixture: ImplementationFixture,
  controller: AbortController,
) {
  const submit = fixture.dependencies.terminalPlugin.onInput.bind(
    fixture.dependencies.terminalPlugin,
  );
  fixture.dependencies.terminalPlugin.onInput = async (tab, text, chord) => {
    if (text.startsWith("Implementation assignment\n")) return;
    await submit(tab, text, chord);
  };
  fixture.state.onSleep = async (ms) => {
    if (ms === 250) controller.abort();
  };
}

export async function otherCheckpoint(directory: string, inputHash: string) {
  const recovery = path.join(directory, "recovery");
  const files = (await readdir(recovery)).filter(
    (name) => name.endsWith("-50.json") && !name.startsWith(`${inputHash}-`),
  );
  assert.equal(files.length, 1);
  return {
    file: path.join(recovery, files[0]!),
    progress: JSON.parse(
      await readFile(path.join(recovery, files[0]!), "utf8"),
    ) as { execution_id: string; input_hash: string; worktree: string },
  };
}
