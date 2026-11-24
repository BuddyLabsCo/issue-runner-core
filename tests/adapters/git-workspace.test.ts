import assert from "node:assert/strict";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { LocalGitWorkspace } from "../../src/adapters/git-workspace.ts";

await test("Agent stages inherit their terminal environment without a temporary Git config", async (t) => {
  const directory = await mkdtemp(path.join(tmpdir(), "core-agent-env-"));
  t.after(() => rm(directory, { recursive: true, force: true }));

  const workspace = new LocalGitWorkspace();
  const overlay = await workspace.withAgentEnvironment(directory, (env) =>
    Promise.resolve(env),
  );

  assert.deepEqual(overlay, {});
  assert.deepEqual(await readdir(directory), []);
});
