/* eslint-disable @typescript-eslint/require-await -- Scripted external contracts retain asynchronous signatures. */
import assert from "node:assert/strict";
import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { executeCli } from "../../src/cli.ts";
import { createCliDependencies } from "../support/cli-dependencies.ts";

await test("help and version need no Project, credentials, plugin, or delivery resources", async (t) => {
  const launchDirectory = await mkdtemp(path.join(tmpdir(), "core-startup "));
  t.after(() => rm(launchDirectory, { recursive: true, force: true }));
  for (const argv of [
    [],
    ["--help"],
    ["run", "-h"],
    ["init", "--help"],
    ["--version"],
  ]) {
    const messages: string[] = [];
    const result = await executeCli(argv, {
      launchDirectory,
      env: {},
      operator: {
        write(message) {
          messages.push(message);
        },
        async pause() {
          assert.fail("informational commands must not pause");
        },
      },
    });
    assert.equal(result.exitCode, 0);
    assert.ok(messages.join("\n").length > 0);
    if (argv[0] === "init")
      assert.match(messages.join("\n"), /^usage: issue-runner init --project/);
  }
  assert.deepEqual(await readdir(launchDirectory), []);
});

await test("init creates a Project without credentials and refuses to overwrite it", async (t) => {
  const launchDirectory = await mkdtemp(path.join(tmpdir(), "core-init "));
  t.after(() => rm(launchDirectory, { recursive: true, force: true }));
  const dependencies = {
    launchDirectory,
    env: {},
    operator: {
      write() {
        /* Init output is checked through its created files. */
      },
      async pause(): Promise<"cancel"> {
        return "cancel";
      },
    },
  };
  const args = ["init", "--project", "demo"];
  assert.equal((await executeCli(args, dependencies)).exitCode, 0);
  const config = await readFile(
    path.join(launchDirectory, "demo/config.yaml"),
    "utf8",
  );
  for (const purpose of ["implement", "review", "documentation"]) {
    assert.ok(
      (
        await readFile(
          path.join(launchDirectory, `demo/prompts/${purpose}.md`),
          "utf8",
        )
      ).trim(),
    );
  }
  assert.equal((await executeCli(args, dependencies)).exitCode, 1);
  assert.equal(
    await readFile(path.join(launchDirectory, "demo/config.yaml"), "utf8"),
    config,
  );
  const runDependencies = createCliDependencies(launchDirectory);
  const generated = await executeCli(
    ["run", "--project", "demo", "--env", "fake", "--parent", "48"],
    { ...runDependencies, env: { GH_TOKEN: "test" } },
  );
  assert.equal(
    generated.summary.outcome,
    "no_work",
    generated.summary.reasons.join(" "),
  );
  for (const project of [
    ".",
    "..",
    "../escape",
    "nested/project",
    "/absolute",
  ]) {
    assert.equal(
      (await executeCli(["init", "--project", project], dependencies)).exitCode,
      1,
    );
  }
});
