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
import { createCliDependencies } from "../support/cli-dependencies.ts";
import { createProject, validConfig } from "../support/cli-project.ts";

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

  const client = new GitHubClient("fixture-credential");
  const result = await client.graphql("query Example { nodes }", {});
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
          'assert.equal(process.env.GH_TOKEN, "shared-secret");',
          "switch (request.variables.scenario) {",
          'case "partial":',
          "  process.stdout.write(JSON.stringify({",
          "    data: { reserved: { input: request.variables.input, query: request.query }, assigned: null },",
          '    errors: [{ message: "denied shared-secret", path: ["assigned", "assignees", 0], extensions: { code: "FORBIDDEN" } }],',
          '    extensions: { requestId: "request-123" },',
          "  }));",
          '  process.stderr.write("gh: denied shared-secret");',
          "  process.exitCode = 1;",
          "  break;",
          'case "empty": process.stdout.write(JSON.stringify({data: { nodes: [] }})); break;',
          'case "missing": process.stdout.write(JSON.stringify({data: null})); break;',
          'case "blank": break;',
          'case "errors": process.stdout.write(JSON.stringify({errors: [{message: "not authorized"}]})); process.exitCode = 1; break;',
          'case "invalid": process.stdout.write("invalid JSON shared-secret"); process.exitCode = 1; break;',
          'case "lost": process.stderr.write("connection reset shared-secret"); process.exitCode = 1; break;',
          "}",
        ].join("\n"),
      { mode: 0o700 },
    );

    const client = new GitHubClient("shared-secret");
    const query =
      "mutation Example {\n  reserved: reserve\n  assigned: assign\n}";
    const input = {
      title: "@draft $title",
      body: "Line one\n\n{owner} の本文\r\nCloses #369\n",
    };
    const partial = await client.graphql(query, { scenario: "partial", input });
    assert.deepEqual(partial.response, {
      data: { reserved: { input, query }, assigned: null },
      errors: [
        {
          message: "denied [redacted]",
          path: ["assigned", "assignees", 0],
          extensions: { code: "FORBIDDEN" },
        },
      ],
      extensions: { requestId: "request-123" },
    });
    assert.match(
      partial.commandError?.message ?? "",
      /gh: denied \[redacted\]/u,
    );
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
      message: "gh command failed: connection reset [redacted]",
    });
  },
);

await executableTest(
  "the CLI uses the same configured credential for Issue, Code Host, and Git operations",
  async (t) => {
    const bin = await installFakeExecutables(t);
    const { root } = await createProject(t, {
      ...validConfig,
      operationRetry: 0,
    });
    await writeFile(
      path.join(bin, "gh"),
      "#!/usr/bin/env node\n" +
        [
          'const assert = require("node:assert/strict");',
          'const fs = require("node:fs");',
          'const path = require("node:path");',
          'assert.equal(process.env.GH_TOKEN, "shared-secret");',
          "const [, , command, methodFlag, method, endpoint] = process.argv;",
          'assert.equal(command, "api");',
          'assert.equal(methodFlag, "--method");',
          'const reserved = path.join(__dirname, "reserved");',
          'const assigned = path.join(__dirname, "assigned");',
          'if (endpoint === "repos/owner/repo" && method === "GET") {',
          '  console.log(JSON.stringify({ default_branch: "fixture-base" }));',
          '} else if (endpoint === "repos/owner/repo/issues/48" && method === "GET") {',
          '  const labels = [{ name: "ready-for-agent" }];',
          '  if (fs.existsSync(reserved)) labels.push({ name: "sandcastle:reserved" });',
          '  const assignees = fs.existsSync(assigned) ? [{ login: "runner" }] : [];',
          '  console.log(JSON.stringify({ number: 48, state: "open", labels, assignees }));',
          '} else if (endpoint.endsWith("/blocked_by") && method === "GET") {',
          '  console.log("[]");',
          '} else if (endpoint.endsWith("/labels") && method === "POST") {',
          '  fs.writeFileSync(reserved, "");',
          "} else {",
          '  assert.equal(endpoint, "repos/owner/repo/issues/48/assignees");',
          '  assert.equal(method, "POST");',
          '  fs.writeFileSync(assigned, "");',
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
          'const expected = Buffer.from("x-access-token:" + "shared-secret").toString("base64");',
          'assert.equal(process.env.GIT_CONFIG_KEY_0, "http.https://github.com/.extraHeader");',
          'assert.equal(process.env.GIT_CONFIG_VALUE_0, "Authorization: Basic " + expected);',
          'process.stderr.write("fixture stopped after verifying Git authentication");',
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
        env: { HOST_TOKEN: "shared-secret" },
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
      /fixture stopped after verifying Git authentication/u,
    );
  },
);
