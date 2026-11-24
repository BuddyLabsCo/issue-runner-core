import assert from "node:assert/strict";
import childProcess, {
  type ExecFileException,
  type ExecFileOptionsWithStringEncoding,
} from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import path from "node:path";
import test, { type TestContext } from "node:test";
import { executeCli } from "../../src/cli.ts";
import { GitHubClient } from "../../src/adapters/github-client.ts";
import {
  createCliDependencies,
  testViewer,
} from "../support/cli-dependencies.ts";
import { createProject, validConfig } from "../support/cli-project.ts";
import {
  child,
  connection,
  repository,
} from "../support/github-parent-discovery.ts";

const executableTest = process.platform === "win32" ? test.skip : test;

await test("GraphQL preserves the response and timeout when the child exits zero after termination", async (t) => {
  const response = { data: { nodes: [] } };
  const command = t.mock.method(
    childProcess,
    "execFile",
    (
      _file: string,
      args: string[],
      options: ExecFileOptionsWithStringEncoding,
      callback: (
        error: ExecFileException | null,
        stdout: string,
        stderr: string,
      ) => void,
    ) => {
      assert.equal(options.timeout, 60_000);
      const error =
        args[0] === "api"
          ? null
          : Object.assign(new Error("checks failed"), { code: 1 });
      queueMicrotask(() => callback(error, JSON.stringify(response), ""));
      return Object.assign(new childProcess.ChildProcess(), { killed: true });
    },
  );
  syncBuiltinESMExports();
  t.after(() => {
    command.mock.restore();
    syncBuiltinESMExports();
  });

  const client = new GitHubClient();
  const result = await client.graphql("query Example { nodes }", {});
  assert.equal(result.exitCode, undefined);
  assert.deepEqual(result.response, response);
  assert.match(result.commandError?.message ?? "", /timed out after 60000 ms/u);
  await assert.rejects(
    client.request(["pr", "checks"], [1]),
    /timed out after 60000 ms/u,
  );
});

async function installFakeExecutables(t: TestContext) {
  const bin = await mkdtemp(path.join(tmpdir(), "runner-bin-"));
  t.after(() => rm(bin, { recursive: true, force: true }));
  const originalPath = process.env.PATH;
  process.env.PATH = [bin, originalPath].join(path.delimiter);
  t.after(() => {
    process.env.PATH = originalPath;
  });
  return bin;
}

await executableTest(
  "gh inherits its existing authenticated environment",
  async (t) => {
    const bin = await installFakeExecutables(t);
    const previous = process.env.GH_TOKEN;
    process.env.GH_TOKEN = "ambient-gh-credential";
    t.after(() => {
      if (previous === undefined) delete process.env.GH_TOKEN;
      else process.env.GH_TOKEN = previous;
    });
    await writeFile(
      path.join(bin, "gh"),
      "#!/usr/bin/env node\n" +
        [
          'const assert = require("node:assert/strict");',
          'assert.equal(process.env.GH_TOKEN, "ambient-gh-credential");',
          "process.stdout.write(JSON.stringify({data: {nodes: []}}));",
        ].join("\n"),
      { mode: 0o700 },
    );

    const client = new GitHubClient();
    assert.deepEqual(await client.graphql("query Example { nodes }", {}), {
      response: { data: { nodes: [] } },
      commandError: null,
    });
  },
);

await executableTest(
  "GraphQL preserves structured input and partial evidence from a failed gh command",
  async (t) => {
    const bin = await installFakeExecutables(t);
    const gh = path.join(bin, "gh");
    await writeFile(
      gh,
      "#!/usr/bin/env node\n" +
        [
          'const { readFileSync } = require("node:fs");',
          'const assert = require("node:assert/strict");',
          'const request = JSON.parse(readFileSync(0, "utf8"));',
          'assert.deepEqual(process.argv.slice(2), ["api", "graphql", "--method", "POST", "--input", "-"]);',
          "switch (request.variables.scenario) {",
          'case "partial":',
          "  process.stdout.write(JSON.stringify({",
          "    data: { reserved: { input: request.variables.input, query: request.query }, assigned: null },",
          '    errors: [{ message: "denied", path: ["assigned", "assignees", 0], extensions: { code: "FORBIDDEN" } }],',
          '    extensions: { requestId: "request-123" },',
          "  }));",
          '  process.stderr.write("gh: denied");',
          "  process.exitCode = 1;",
          "  break;",
          'case "empty": process.stdout.write(JSON.stringify({data: { nodes: [] }})); break;',
          'case "missing": process.stdout.write(JSON.stringify({data: null})); break;',
          'case "blank": break;',
          'case "errors": process.stdout.write(JSON.stringify({errors: [{message: "not authorized"}]})); process.exitCode = 1; break;',
          'case "invalid": process.stdout.write("invalid JSON"); process.exitCode = 1; break;',
          'case "lost": process.stderr.write("connection reset"); process.exitCode = 1; break;',
          "}",
        ].join("\n"),
      { mode: 0o700 },
    );

    const client = new GitHubClient();
    const query =
      "mutation Example {\n  reserved: reserve\n  assigned: assign\n}";
    const input = {
      title: "@draft $title",
      body: "Line one\n\n{owner} の本文\r\nCloses #369\n",
    };
    const partial = await client.graphql(query, { scenario: "partial", input });
    assert.equal(partial.exitCode, 1);
    assert.deepEqual(partial.response, {
      data: { reserved: { input, query }, assigned: null },
      errors: [
        {
          message: "denied",
          path: ["assigned", "assignees", 0],
          extensions: { code: "FORBIDDEN" },
        },
      ],
      extensions: { requestId: "request-123" },
    });
    assert.match(partial.commandError?.message ?? "", /gh: denied/u);
    assert.deepEqual(await client.graphql(query, { scenario: "empty" }), {
      response: { data: { nodes: [] } },
      commandError: null,
    });
    assert.deepEqual(await client.graphql(query, { scenario: "missing" }), {
      response: { data: null },
      commandError: null,
    });
    const errorsOnly = await client.graphql(query, { scenario: "errors" });
    assert.deepEqual(errorsOnly.response, {
      errors: [{ message: "not authorized" }],
    });
    assert.ok(errorsOnly.commandError);
    await assert.rejects(client.graphql(query, { scenario: "blank" }), {
      message: "GitHub returned no GraphQL response",
    });
    await assert.rejects(client.graphql(query, { scenario: "invalid" }), {
      message: "GitHub returned invalid GraphQL JSON",
    });
    await assert.rejects(client.graphql(query, { scenario: "lost" }), {
      message: "gh command failed: connection reset",
    });
  },
);

await executableTest(
  "the CLI leaves gh and Git authentication to the inherited environment",
  async (t) => {
    const bin = await installFakeExecutables(t);
    const inherited = {
      GH_TOKEN: process.env.GH_TOKEN,
      GIT_CONFIG_KEY_0: process.env.GIT_CONFIG_KEY_0,
      GIT_CONFIG_VALUE_0: process.env.GIT_CONFIG_VALUE_0,
    };
    process.env.GH_TOKEN = "ambient-gh-credential";
    process.env.GIT_CONFIG_KEY_0 = "ambient-config-key";
    process.env.GIT_CONFIG_VALUE_0 = "ambient-config-value";
    t.after(() => {
      for (const [name, value] of Object.entries(inherited)) {
        if (value === undefined) delete process.env[name];
        else process.env[name] = value;
      }
    });
    const { root } = await createProject(t, {
      ...validConfig,
      operationRetry: 0,
    });
    const label = {
      id: "reservation-id",
      name: validConfig.tracker.reservationLabel,
    };
    const runner = {
      id: testViewer.id,
      login: testViewer.login,
    };
    const ready = { id: "ready-id", name: "ready-for-agent" };
    const target = child(48, {
      title: "Verify credential",
      body: "",
      url: "https://github.com/owner/repo/issues/48",
      labels: connection([ready]),
    });
    const start = {
      data: { repository: { ...repository, label, target }, viewer: runner },
    };
    const confirmed = {
      data: {
        addReservation: { labelable: target },
        addRunner: {
          assignable: {
            ...target,
            labels: connection([ready, label]),
            assignees: connection([runner]),
          },
        },
      },
    };
    await writeFile(
      path.join(bin, "gh"),
      "#!/usr/bin/env node\n" +
        [
          'const assert = require("node:assert/strict");',
          'const fs = require("node:fs");',
          'assert.equal(process.env.GH_TOKEN, "ambient-gh-credential");',
          "const args = process.argv.slice(2);",
          'if (args[3] === "repos/owner/repo") {',
          '  assert.deepEqual(args, ["api", "--method", "GET", "repos/owner/repo"]);',
          '  console.log(JSON.stringify({ default_branch: "fixture-base" }));',
          "} else {",
          '  assert.deepEqual(args, ["api", "graphql", "--method", "POST", "--input", "-"]);',
          '  const { query, variables } = JSON.parse(fs.readFileSync(0, "utf8"));',
          '  if (query.startsWith("query IssueStart")) {',
          `    assert.deepEqual(variables, { owner: "owner", name: "repo", number: 48, reservation: ${JSON.stringify(label.name)} });`,
          `    console.log(JSON.stringify(${JSON.stringify(start)}));`,
          "  } else {",
          '    assert.ok(query.startsWith("mutation ReserveIssue"));',
          `    assert.deepEqual(variables, { issue: "issue-48", label: ${JSON.stringify(label.id)}, viewer: ${JSON.stringify(runner.id)} });`,
          `    console.log(JSON.stringify(${JSON.stringify(confirmed)}));`,
          "  }",
          "}",
        ].join("\n"),
      { mode: 0o700 },
    );
    await writeFile(
      path.join(bin, "git"),
      "#!/usr/bin/env node\n" +
        [
          'const assert = require("node:assert/strict");',
          'assert.deepEqual(process.argv.slice(2), ["fetch", "--no-tags", "origin", "fixture-base"]);',
          'assert.equal(process.env.GH_TOKEN, "ambient-gh-credential");',
          'assert.equal(process.env.GIT_CONFIG_KEY_0, "ambient-config-key");',
          'assert.equal(process.env.GIT_CONFIG_VALUE_0, "ambient-config-value");',
          'process.stderr.write("fixture stopped after verifying the Git environment");',
          "process.exitCode = 1;",
        ].join("\n"),
      { mode: 0o700 },
    );

    const { launchDirectory, terminal, enhancements, clock } =
      createCliDependencies(root);
    const pauses: string[] = [];
    const result = await executeCli(
      ["run", "--project", "demo", "--issue", "48"],
      {
        launchDirectory,
        terminal,
        enhancements,
        clock,
        commandName: "generic-terminal",
        commandVersion: "2.3.4",
        terminalPackageRoot: root,
        terminalCliEntry: path.join(root, "cli.mjs"),
        operator: {
          write() {
            /* The fixture stops at the first Git command. */
          },
          pause(message) {
            pauses.push(message);
            return Promise.resolve("q");
          },
        },
      },
    );
    assert.equal(
      result.summary.outcome,
      "cancelled",
      JSON.stringify(result.summary),
    );
    assert.equal(pauses.length, 1);
    assert.match(
      pauses[0]!,
      /fixture stopped after verifying the Git environment/u,
    );
  },
);
