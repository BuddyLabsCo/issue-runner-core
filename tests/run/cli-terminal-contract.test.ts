import assert from "node:assert/strict";
import { writeFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { stringify } from "yaml";
import { executeCli } from "../../src/cli.ts";
import { loadProject } from "../../src/config.ts";
import { agent, createProject, validConfig } from "../support/cli-project.ts";
import { createCliDependencies } from "../support/cli-dependencies.ts";

const run = ["run", "--project", "demo", "--env", "fake", "--parent", "48"];

await test("injected terminal plugins require all five methods before external access", async (t) => {
  const { root } = await createProject(t);
  for (const method of [
    "createTab",
    "start",
    "resume",
    "submitText",
    "closeTab",
  ]) {
    const deps = createCliDependencies(root);
    Object.assign(deps.terminalPlugin, { [method]: undefined });
    const result = await executeCli(run, deps);
    assert.equal(result.exitCode, 1);
    assert.match(
      result.summary.reasons.join(" "),
      /must implement createTab, start, resume, submitText, and closeTab/,
    );
    assert.deepEqual(deps.reads, []);
    assert.deepEqual(deps.effects, []);
  }
});

await test("Agent profiles require an opaque nonempty agent before external access", async (t) => {
  const { root, directory } = await createProject(t);
  for (const purpose of [
    "implement",
    "review",
    "ciRepair",
    "conflictRepair",
    "documentation",
  ]) {
    for (const value of [undefined, "", " \n ", null, 42]) {
      await writeFile(
        path.join(directory, "config.yaml"),
        stringify({
          ...validConfig,
          agents: {
            ...validConfig.agents,
            [purpose]: { ...agent, agent: value },
          },
        }),
      );
      const deps = createCliDependencies(root);
      const result = await executeCli(run, deps);
      assert.match(
        result.summary.reasons.join(" "),
        new RegExp(`agents\\.${purpose}\\.agent must be set`),
      );
      assert.deepEqual(deps.reads, []);
      assert.deepEqual(deps.effects, []);
    }
  }
  const opaque = "  Custom.Agent/$&  ";
  await writeFile(
    path.join(directory, "config.yaml"),
    stringify({
      ...validConfig,
      agents: Object.fromEntries(
        [
          "implement",
          "review",
          "ciRepair",
          "conflictRepair",
          "documentation",
        ].map((purpose) => [purpose, { ...agent, agent: opaque }]),
      ),
    }),
  );
  const loaded = await loadProject(root, "demo", {
    TRACKER_TOKEN: "test",
    HOST_TOKEN: "test",
  });
  assert.deepEqual(
    Object.values(loaded.config.agents).map((profile) => profile.agent),
    Array(5).fill(opaque),
  );
});
