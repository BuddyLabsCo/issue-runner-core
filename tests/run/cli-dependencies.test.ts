import assert from "node:assert/strict";
import test from "node:test";
import { setImmediate } from "node:timers/promises";
import { createCliDependencies } from "../support/cli-dependencies.ts";

await test("concurrent fixture PR creation assigns unique numbers after delayed head lookups", async () => {
  const { codeHost } = createCliDependencies(process.cwd());
  codeHost.getRemoteBranchHead = async (_repository, branch) => {
    await setImmediate();
    return branch === "ticket-51" ? "a".repeat(40) : "b".repeat(40);
  };
  const created = await Promise.all(
    [51, 52].map((ticket) =>
      codeHost.createPullRequest({
        repository: "owner/repo",
        branch: `ticket-${ticket}`,
        targetBranch: "main",
        title: `Implement #${ticket}`,
        body: `Closes #${ticket}`,
      }),
    ),
  );
  assert.deepEqual(
    created.map((pr) => pr.number),
    [81, 82],
  );
  const records = await codeHost.listPullRequests();
  assert.deepEqual(
    records.map(({ number, branch, headSha }) => ({ number, branch, headSha })),
    [
      { number: 81, branch: "ticket-51", headSha: "a".repeat(40) },
      { number: 82, branch: "ticket-52", headSha: "b".repeat(40) },
    ],
  );
});
