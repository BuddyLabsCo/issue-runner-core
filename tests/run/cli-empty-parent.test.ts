/* eslint-disable @typescript-eslint/require-await -- Scripted external contracts retain asynchronous signatures. */
import assert from "node:assert/strict";
import { readdir, readFile, rename, mkdir, rmdir } from "node:fs/promises";
import path from "node:path";
import test from "node:test";

import { executeCli } from "../../src/cli.ts";
import { createProject } from "../support/cli-project.ts";
import { createCliDependencies } from "../support/cli-dependencies.ts";
import type { ChildPage } from "../../src/run/contracts.ts";

await test("an empty parent returns no_work through the application without closing or dispatching", async (t) => {
  const { root, directory } = await createProject(t);
  const dependencies = createCliDependencies(root);
  const result = await executeCli(
    ["run", "--env", "fake", "--project", "demo", "--parent", "48"],
    dependencies,
  );
  assert.equal(result.exitCode, 0);
  assert.equal(result.summary.outcome, "no_work");
  assert.equal(result.summary.parentTicket, 48);
  assert.equal(result.summary.targetBranch, "default-branch");
  assert.deepEqual(dependencies.effects, []);
  assert.deepEqual(dependencies.reads, [
    "branch:owner/repo",
    "owner/repo#48",
    "children:1",
  ]);
  assert.deepEqual((await readdir(directory)).sort(), [
    "config.yaml",
    "logs",
    "prompts",
  ]);
  assert.ok(result.logPath);
  const audit = await readFile(result.logPath, "utf8");
  assert.ok(
    dependencies.messages.some((message) => message.includes("sessionid=n/a")),
  );
  const events = audit
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line) as { operation: string; result: string });
  assert.ok(
    events.some(
      (event) => event.operation === "run" && event.result === "no_work",
    ),
  );
  assert.doesNotMatch(audit, /tracker-secret|host-secret/);
});

await test("a failed audit append retries logging without replaying a completed tracker read", async (t) => {
  const { root, directory } = await createProject(t);
  const deps = createCliDependencies(root);
  let auditFile = "";
  let reads = 0;
  deps.tracker.getParent = async () => {
    reads += 1;
    const [name] = await readdir(path.join(directory, "logs"));
    assert.ok(name);
    auditFile = path.join(directory, "logs", name);
    await rename(auditFile, `${auditFile}.saved`);
    await mkdir(auditFile);
    return { number: 48, state: "open", stateReason: null };
  };
  deps.operator.pause = async (message) => {
    assert.match(message, /Audit write failed/);
    await rmdir(auditFile);
    await rename(`${auditFile}.saved`, auditFile);
    return "";
  };
  const result = await executeCli(
    ["run", "--project", "demo", "--env", "fake", "--parent", "48"],
    deps,
  );
  assert.equal(result.summary.outcome, "no_work");
  assert.equal(reads, 1);
});

await test("pagination cannot hide ineligible children or turn a nonempty parent into no_work", async (t) => {
  const { root } = await createProject(t);
  const deps = createCliDependencies(root);
  const result = await executeCli(
    ["run", "--project", "demo", "--env", "fake", "--parent", "48"],
    {
      ...deps,
      tracker: {
        ...deps.tracker,
        async listChildrenPage(_repository, _parent, page): Promise<ChildPage> {
          return page === 1
            ? { children: [], nextPage: 2 }
            : {
                children: [
                  {
                    number: 49,
                    repository: "owner/repo",
                    state: "open",
                    stateReason: null,
                  },
                ],
                nextPage: null,
              };
        },
      },
    },
  );
  assert.equal(result.summary.outcome, "incomplete");
  assert.deepEqual(deps.effects, []);
});

await test("cancelled parents stop discovery without rewriting children", async (t) => {
  const { root } = await createProject(t);
  const deps = createCliDependencies(root);
  const result = await executeCli(
    ["run", "--project", "demo", "--env", "fake", "--parent", "48"],
    {
      ...deps,
      tracker: {
        ...deps.tracker,
        async getParent() {
          return { number: 48, state: "closed", stateReason: "not_planned" };
        },
        async listChildrenPage() {
          assert.fail("cancelled parent must stop discovery");
        },
      },
    },
  );
  assert.equal(result.summary.outcome, "cancelled");
  assert.deepEqual(deps.effects, []);
});
