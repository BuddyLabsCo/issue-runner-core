import assert from "node:assert/strict";
import test from "node:test";
import { createCliDependencies } from "../support/cli-dependencies.ts";

await test("concurrent fake Pull Requests have distinct numbers and independent heads", async () => {
  const { codeHost, gitWorkspace } = createCliDependencies(process.cwd());
  const branches = ["issue-51", "issue-52"];
  const heads = ["a".repeat(40), "b".repeat(40)];
  await gitWorkspace.push(process.cwd(), branches[0]!, heads[0]!);
  await gitWorkspace.push(process.cwd(), branches[1]!, heads[1]!);

  const pullRequests = await Promise.all(
    branches.map((branch) =>
      codeHost.createPullRequest({
        repository: "owner/repo",
        targetBranch: "main",
        branch,
        title: `Implement ${branch}`,
        body: `Implement ${branch}`,
      }),
    ),
  );

  assert.deepEqual(
    pullRequests.map((pr) => pr.number),
    [81, 82],
  );
  const states = await Promise.all(
    pullRequests.map((pr) => codeHost.getPullRequest("owner/repo", pr.number)),
  );
  assert.deepEqual(
    states.map((pr) => pr.headSha),
    heads,
  );
});
