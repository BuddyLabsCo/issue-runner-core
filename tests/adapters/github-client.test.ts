/* eslint-disable @typescript-eslint/require-await -- Scripted external boundary. */
import assert from "node:assert/strict";
import test from "node:test";
import {
  GitHubClient,
  GitHubCommandError,
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
