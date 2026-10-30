import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { TestContext } from "node:test";
import { stringify } from "yaml";

export const agent = {
  start: 'any-cli --model "my model" --native-option',
  resume: 'any-cli --resume "{sessionref}"',
  submitKey: "Shift+Enter",
};

export const validConfig = {
  repository: "owner/repo",
  checkout: path.resolve(tmpdir()),
  issueList: [],
  maxBatchSize: 3,
  tracker: {
    tokenEnv: "TRACKER_TOKEN",
    runnerAccount: "runner",
    reservationLabel: "sandcastle:reserved",
  },
  codeHost: { tokenEnv: "HOST_TOKEN", adminMerge: false },
  agents: {
    implement: agent,
    review: agent,
    ciRepair: agent,
    conflictRepair: agent,
  },
  timeouts: {
    agentMinutes: 120,
    requiredChecksMinutes: 60,
    mergeQueueMinutes: 60,
  },
  ticketClosure: "runner",
  operationRetry: 1,
  agentRetry: 2,
  operationRetryDelay: [1],
  agentRetryDelay: [2, 3],
};

export async function createProject(
  t: TestContext,
  config: object = validConfig,
) {
  const root = await mkdtemp(path.join(tmpdir(), "core-project "));
  t.after(() => rm(root, { recursive: true, force: true }));
  const directory = path.join(root, "demo");
  await mkdir(path.join(directory, "prompts"), { recursive: true });
  await writeFile(path.join(directory, "config.yaml"), stringify(config));
  for (const purpose of ["implement", "review", "documentation"]) {
    await writeFile(
      path.join(directory, "prompts", `${purpose}.md`),
      `Project ${purpose} instructions`,
    );
  }
  return { root, directory };
}
