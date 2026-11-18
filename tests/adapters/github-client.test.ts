import assert from "node:assert/strict";
import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import {
  GitHubClient,
  GitHubCommandError,
  GitHubGraphQLError,
} from "../../src/adapters/github-client.ts";
import { GitHubCodeHost } from "../../src/adapters/github-code-host.ts";

await test("GraphQL retains partial data and error paths from a failed gh command", async (t) => {
  const directory = await mkdtemp(path.join(tmpdir(), "github-client-"));
  const oldPath = process.env.PATH;
  t.after(async () => {
    process.env.PATH = oldPath;
    await rm(directory, { recursive: true, force: true });
  });
  const executable = path.join(directory, "gh");
  await writeFile(
    executable,
    `#!/usr/bin/env node
let input = '';
process.stdin.on('data', chunk => input += chunk);
process.stdin.on('end', () => {
  const request = JSON.parse(input);
  process.stdout.write(JSON.stringify({data: {first: request.variables.text, second: null}, errors: [{message: 'denied', path: ['second', 'node']}]}));
  process.stderr.write('failed ' + process.env.GH_TOKEN);
  process.exitCode = 1;
});
`,
  );
  await chmod(executable, 0o755);
  process.env.PATH = `${directory}${path.delimiter}${oldPath}`;
  const client = new GitHubClient("secret-token");
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
