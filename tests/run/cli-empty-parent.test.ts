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
  assert.match(audit, /no_work/);
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

await test("pagination cannot hide children or turn unsupported delivery into no_work", async (t) => {
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

await test("read retries are additional attempts", async (t) => {
  const { root } = await createProject(t);
  const deps = createCliDependencies(root);
  let attempts = 0;
  deps.tracker.getParent = async () => {
    attempts += 1;
    if (attempts === 1) throw new Error("transient tracker failure");
    return { number: 48, state: "open", stateReason: null };
  };
  const result = await executeCli(
    ["run", "--project", "demo", "--env", "fake", "--parent", "48"],
    deps,
  );
  assert.equal(result.summary.outcome, "no_work");
  assert.equal(attempts, 2);
  assert.ok(deps.reads.includes("sleep:1000"));
});

await test("exhausted read retries preserve non-Agent Operator Pause and q cancels", async (t) => {
  const { root } = await createProject(t);
  const deps = createCliDependencies(root);
  let attempts = 0;
  deps.tracker.getParent = async () => {
    attempts += 1;
    throw new Error("tracker unavailable");
  };
  deps.operator.pause = async (message) => {
    deps.pauses.push(message);
    return "q";
  };
  const result = await executeCli(
    ["run", "--project", "demo", "--env", "fake", "--parent", "48"],
    deps,
  );
  assert.equal(result.summary.outcome, "cancelled");
  assert.equal(result.exitCode, 1);
  assert.equal(attempts, 2);
  assert.match(deps.pauses.join(" "), /tracker unavailable/);
  assert.deepEqual(deps.effects, []);
});

await test("cancellation during backoff prevents subsequent tracker reads", async (t) => {
  const { root } = await createProject(t);
  const deps = createCliDependencies(root);
  const controller = new AbortController();
  let attempts = 0;
  deps.tracker.getParent = async () => {
    attempts += 1;
    throw new Error("retry");
  };
  deps.clock.sleep = async () => {
    controller.abort();
  };
  const result = await executeCli(
    ["run", "--project", "demo", "--env", "fake", "--parent", "48"],
    { ...deps, signal: controller.signal },
  );
  assert.equal(result.summary.outcome, "cancelled");
  assert.equal(attempts, 1);
  assert.deepEqual(deps.effects, []);
});
