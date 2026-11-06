import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { compileFunction } from "node:vm";
import { parse } from "yaml";

const workflow = parse(
  readFileSync(
    new URL("../../.github/workflows/ci.yml", import.meta.url),
    "utf8",
  ),
) as { jobs: { "release-merge": { steps: { with: { script: string } }[] } } };
const step = workflow.jobs["release-merge"].steps[0];
assert.ok(step);
const classify = compileFunction(
  `return (async () => { ${step.with.script} })()`,
  ["github", "context"],
) as (github: unknown, context: unknown) => Promise<boolean>;
const context = {
  repo: { owner: "BuddyLabsCo", repo: "issue-runner-core" },
  sha: "merged-commit",
};
const release = {
  merged_at: "2026-11-06T00:00:00Z",
  merge_commit_sha: context.sha,
  base: { ref: "main" },
  head: {
    ref: "auto-release",
    repo: { full_name: "BuddyLabsCo/issue-runner-core" },
  },
};

for (const [name, pulls, skip] of [
  ["a release merge", [release], true],
  ["a direct push", [], false],
  ["an unmerged release PR", [{ ...release, merged_at: null }], false],
  ["a later push", [{ ...release, merge_commit_sha: "older-commit" }], false],
  ["another target branch", [{ ...release, base: { ref: "other" } }], false],
  [
    "an ordinary PR",
    [{ ...release, head: { ...release.head, ref: "feature" } }],
    false,
  ],
  [
    "a fork's auto-release branch",
    [
      {
        ...release,
        head: { ...release.head, repo: { full_name: "fork/core" } },
      },
    ],
    false,
  ],
  [
    "a deleted source repository",
    [{ ...release, head: { ...release.head, repo: null } }],
    false,
  ],
] as const) {
  await test(`main CI classification: ${name}`, async () => {
    const endpoint = {};
    const github = {
      rest: { repos: { listPullRequestsAssociatedWithCommit: endpoint } },
      paginate: (method: unknown, args: unknown) => {
        assert.equal(method, endpoint);
        assert.deepEqual(args, { ...context.repo, commit_sha: context.sha });
        return Promise.resolve(pulls);
      },
    };
    assert.equal(await classify(github, context), skip);
  });
}
