/* eslint-disable @typescript-eslint/require-await -- Scripted GitHub command. */
import assert from "node:assert/strict";
import test from "node:test";
import { GitHubTracker } from "../../src/adapters/github-tracker.ts";
import type { GitHubCommand } from "../../src/adapters/github-client.ts";
import { runner } from "../support/github-parent-discovery.ts";

await test("viewer lookup requests only the authenticated viewer identity", async () => {
  const command: GitHubCommand = async (args, { input }) => {
    assert.deepEqual(args, [
      "api",
      "graphql",
      "--method",
      "POST",
      "--input",
      "-",
    ]);
    const { query, variables } = JSON.parse(input!) as {
      query: string;
      variables: unknown;
    };
    assert.match(query, /^query Viewer \{ viewer \{ id login \} \}$/u);
    assert.deepEqual(variables, {});
    return JSON.stringify({ data: { viewer: runner } });
  };

  assert.deepEqual(await new GitHubTracker(command).readViewer(), runner);
});

for (const [name, viewer] of [
  ["a missing viewer", null],
  ["an invalid non-user viewer", { id: "app-id", login: "" }],
] as const) {
  await test(`viewer lookup rejects ${name} with a clear error`, async () => {
    const tracker = new GitHubTracker(async () =>
      JSON.stringify({ data: { viewer } }),
    );
    await assert.rejects(
      tracker.readViewer(),
      /authenticated as a normal GitHub user/u,
    );
  });
}
