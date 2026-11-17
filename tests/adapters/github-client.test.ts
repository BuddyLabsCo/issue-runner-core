/* eslint-disable @typescript-eslint/require-await -- Scripted external boundary. */
import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  GitHubClient,
  GitHubCommandError,
  runGitHubCommand,
} from "../../src/adapters/github-client.ts";

await test("GraphQL retains partial data, error paths, and failed command evidence", async () => {
  const envelope = {
    data: { first: { id: "1" }, second: null },
    errors: [{ message: "denied", path: ["second"] }],
  };
  const failure = new GitHubCommandError(
    "gh command failed",
    JSON.stringify(envelope),
  );
  const client = new GitHubClient("secret", async (args, options) => {
    assert.deepEqual(args, ["api", "graphql", "--input", "-"]);
    assert.deepEqual(JSON.parse(options.input!), {
      query: "query\n{ first }",
      variables: { body: "line 1\nline 2" },
    });
    throw failure;
  });
  assert.deepEqual(
    await client.graphql("query\n{ first }", { body: "line 1\nline 2" }),
    { ...envelope, commandError: failure },
  );
});

await test("GraphQL distinguishes missing or invalid responses from empty data", async () => {
  for (const output of ["", "not JSON", "{}", "[]"]) {
    const client = new GitHubClient("secret", async () => output);
    await assert.rejects(client.graphql("query", {}), /invalid GraphQL/u);
  }
  const client = new GitHubClient("secret", async () => '{"data":{}}');
  assert.deepEqual(await client.graphql("query", {}), { data: {} });
  const failure = new GitHubCommandError("timeout", "");
  const failed = new GitHubClient("secret", async () => {
    throw failure;
  });
  await assert.rejects(
    failed.graphql("query", {}),
    (error) => error === failure,
  );
});

await test(
  "real gh failures distinguish timeouts and redact partial output",
  { skip: process.platform === "win32" },
  async (t) => {
    const directory = await mkdtemp(path.join(tmpdir(), "fake-gh-"));
    const previousPath = process.env.PATH;
    t.after(async () => {
      process.env.PATH = previousPath;
      await rm(directory, { recursive: true, force: true });
    });
    await writeFile(
      path.join(directory, "gh"),
      `#!/bin/sh\nprintf '{"data":{"first":"secret"}}'\nprintf 'secret error' >&2\nexec sleep 10\n`,
      { mode: 0o755 },
    );
    process.env.PATH = `${directory}${path.delimiter}${previousPath ?? ""}`;
    await assert.rejects(
      runGitHubCommand([], { token: "secret", timeout: 200 }),
      (error: unknown) => {
        assert.ok(error instanceof GitHubCommandError);
        assert.equal(error.timedOut, true);
        assert.doesNotMatch(error.message + error.stdout, /secret/u);
        assert.match(error.stdout, /redacted/u);
        return true;
      },
    );
  },
);
