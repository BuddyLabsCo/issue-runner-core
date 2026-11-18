import assert from "node:assert/strict";
import test from "node:test";
import {
  GitHubClient,
  GitHubCommandError,
  GitHubGraphQLError,
  runGitHubCommand,
} from "../../src/adapters/github-client.ts";
import { GitHubCodeHost } from "../../src/adapters/github-code-host.ts";

await test("GraphQL retains partial data and error paths from a failed gh command", async () => {
  const script = `
let input = '';
process.stdin.on('data', chunk => input += chunk);
process.stdin.on('end', () => {
  const request = JSON.parse(input);
  process.stdout.write(JSON.stringify({data: {first: request.variables.text, second: null}, errors: [{message: 'denied', path: ['second', 'node']}]}));
  process.stderr.write('failed ' + process.env.GH_TOKEN);
  process.exitCode = 1;
});`;
  const client = new GitHubClient("secret-token", (args, options) => {
    assert.deepEqual(args, ["api", "graphql", "--input", "-"]);
    return runGitHubCommand(["-e", script], options, process.execPath);
  });
  await assert.rejects(
    client.graphql("query\n{ first second }", { text: "line one\nline two" }),
    (error: unknown) => {
      assert.ok(error instanceof GitHubGraphQLError);
      assert.deepEqual(error.response, {
        data: { first: "line one\nline two", second: null },
        errors: [{ message: "denied", path: ["second", "node"] }],
      });
      assert.ok(error.cause instanceof GitHubCommandError);
      assert.match(error.cause.message, /\[redacted\]/);
      assert.doesNotMatch(error.cause.message, /secret-token/);
      return true;
    },
  );
});

await test("GraphQL distinguishes empty and malformed payloads from valid empty results", async () => {
  for (const [output, message] of [
    ["", /no GraphQL payload/],
    ["{", /invalid GraphQL JSON/],
    ["{}", /no GraphQL data or errors/],
    ['{"errors":[]}', /no GraphQL data or errors/],
    ['{"errors":null}', /no GraphQL data or errors/],
    ['{"data":null,"errors":[]}', /no GraphQL data or errors/],
    ['{"errors":[{}]}', /no GraphQL data or errors/],
  ] as const) {
    const client = new GitHubClient("token", () => Promise.resolve(output));
    await assert.rejects(client.graphql("query {}", {}), message);
  }
  const timeout = new GitHubClient("token", () =>
    Promise.reject(new GitHubCommandError("gh command timed out", "")),
  );
  await assert.rejects(
    timeout.graphql("query {}", {}),
    /no GraphQL payload: gh command timed out/,
  );
  const client = new GitHubClient("token", () =>
    Promise.resolve('{"data":{"items":[]}}'),
  );
  assert.deepEqual(await client.graphql("query {}", {}), {
    data: { items: [] },
  });
});

await test("Pull Request observation rejects partial GraphQL errors", async () => {
  const response = {
    data: { repository: { pullRequest: null } },
    errors: [{ message: "denied", path: ["repository", "pullRequest"] }],
  };
  const host = new GitHubCodeHost("token", () =>
    Promise.resolve(JSON.stringify(response)),
  );
  await assert.rejects(
    host.getPullRequest("owner/repo", 1),
    (error: unknown) => {
      assert.ok(error instanceof GitHubGraphQLError);
      assert.deepEqual(error.response, response);
      return true;
    },
  );
});
