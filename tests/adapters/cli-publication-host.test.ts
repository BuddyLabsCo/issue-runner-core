/* eslint-disable @typescript-eslint/require-await -- Scripted GitHub responses. */
import assert from "node:assert/strict";
import test from "node:test";
import { GitHubCodeHost } from "../../src/adapters/github-code-host.ts";
import { executeCli } from "../../src/cli.ts";
import { implementationCommand } from "../support/implementation-run.ts";
import { publicationRun } from "../support/publication-run.ts";

const repository = { id: "REPO_1", nameWithOwner: "Owner/Repo" };
const head = "a".repeat(40);
const row = (number: number, extra: Record<string, unknown> = {}) => ({
  id: `PR_${number}`,
  number,
  url: `https://github.com/Owner/Repo/pull/${number}`,
  headRefName: "feature",
  baseRefName: "main",
  headRefOid: head,
  state: "OPEN",
  isDraft: false,
  createdAt: "2026-10-30T00:00:00Z",
  headRepository: { nameWithOwner: "Owner/Repo" },
  baseRepository: repository,
  ...extra,
});
const page = (
  nodes: unknown[],
  totalCount = nodes.length,
  endCursor: string | null = null,
) => ({
  nodes,
  totalCount,
  pageInfo: { hasNextPage: endCursor !== null, endCursor },
});
const envelope = (value: unknown) => JSON.stringify({ data: value });

await test("publication sends accepted multiline metadata directly and validates the returned identity", async (t) => {
  const fixture = await publicationRun(t);
  const operations: string[] = [];
  let created = false;
  const adapter = new GitHubCodeHost("host-secret", async (args, options) => {
    assert.equal(options.token, "host-secret");
    if (args[1] === "--method")
      return JSON.stringify({ default_branch: "default-branch" });
    const saved = await fixture.snapshot();
    if (args[1] === "graphql") {
      const request = JSON.parse(options.input!) as {
        query: string;
        variables: Record<string, unknown>;
      };
      if (request.query.startsWith("mutation")) {
        operations.push("create");
        assert.deepEqual(request.variables.input, {
          repositoryId: "REPO_1",
          headRefName: saved.branch,
          baseRefName: "default-branch",
          title: saved.pr_title,
          body: "Implement the Issue.\n\nCloses #50",
          draft: false,
          maintainerCanModify: true,
        });
        created = true;
        return envelope({
          createPullRequest: {
            pullRequest: row(81, {
              headRefName: saved.branch,
              baseRefName: "default-branch",
              headRefOid: saved.publication!.headSha,
            }),
          },
        });
      }
      if (!request.query.includes("source:pullRequests")) {
        operations.push("pre-push");
        return envelope({ repository: { ...repository, ref: null } });
      }
      operations.push("observe");
      return envelope({
        repository: {
          ...repository,
          ref: { target: { oid: saved.publication!.headSha } },
          source: page([]),
          target: page([]),
        },
      });
    }
    if (args[1]?.includes("/git/ref/heads/"))
      return JSON.stringify({ object: { sha: saved.publication!.headSha } });
    if (args.includes("--paginate"))
      return JSON.stringify([
        created
          ? [
              {
                node_id: "PR_81",
                created_at: "2026-10-30T00:00:00Z",
                number: 81,
                html_url: "https://github.com/Owner/Repo/pull/81",
                state: "open",
                merged_at: null,
                draft: false,
                head: {
                  ref: saved.branch,
                  sha: saved.publication!.headSha,
                  repo: { full_name: "Owner/Repo" },
                },
                base: { ref: "default-branch" },
              },
            ]
          : [],
      ]);
    if (args[1] === "checks") return "[]";
    assert.fail(`unexpected command: ${args.join(" ")}`);
  });
  const result = await executeCli(
    [...implementationCommand, "--no-auto-merge"],
    { ...fixture.dependencies, codeHost: adapter },
  );
  assert.ok(result.summary.tickets?.[0], JSON.stringify(result));
  assert.match(
    result.summary.tickets[0].detail,
    /CI-ready/u,
    JSON.stringify(result),
  );
  assert.deepEqual(operations, ["pre-push", "observe", "create"]);
  assert.equal(
    (await fixture.snapshot()).publication?.pullRequest?.id,
    "PR_81",
  );
});

await test("candidate observation paginates each connection independently and deduplicates the union", async () => {
  const variables: Record<string, unknown>[] = [];
  const adapter = new GitHubCodeHost("token", async (_args, options) => {
    const request = JSON.parse(options.input!) as {
      variables: Record<string, unknown>;
    };
    variables.push(request.variables);
    const first = variables.length === 1;
    return envelope({
      repository: {
        ...repository,
        ref: { target: { oid: head } },
        ...(first
          ? {
              source: page([row(1)], 2, "s1"),
              target: page(
                [
                  row(1),
                  row(3, { headRepository: { nameWithOwner: "fork/repo" } }),
                ],
                3,
                "t1",
              ),
            }
          : { source: page([row(2)], 2), target: page([row(2)], 3) }),
      },
    });
  });
  const result = await adapter.observePublication({
    repository: "owner/repo",
    branch: "feature",
    targetBranch: "main",
  });
  assert.deepEqual(
    result.candidates.map(({ id }) => id),
    ["PR_1", "PR_2"],
  );
  assert.equal(variables[1]!.sourceAfter, "s1");
  assert.equal(variables[1]!.targetAfter, "t1");
});

await test("incomplete pages and changing remote heads cannot prove publication absence", async () => {
  for (const failure of ["error", "truncated", "head-change"] as const) {
    let calls = 0;
    const adapter = new GitHubCodeHost("token", async () => {
      calls++;
      if (failure === "error")
        return JSON.stringify({
          data: { repository: null },
          errors: [{ message: "denied" }],
        });
      return envelope({
        repository: {
          ...repository,
          ref: {
            target: {
              oid:
                failure === "head-change" && calls > 1 ? "b".repeat(40) : head,
            },
          },
          source:
            failure === "truncated"
              ? page([], 1)
              : calls === 1
                ? page([row(1)], 2, "next")
                : page([row(2)], 2),
          ...(calls === 1 ? { target: page([]) } : {}),
        },
      });
    });
    await assert.rejects(
      adapter.observePublication({
        repository: "owner/repo",
        branch: "feature",
        targetBranch: "main",
      }),
    );
  }
});

await test("creation rejects a returned PR from a different repository", async () => {
  const adapter = new GitHubCodeHost("token", async () =>
    envelope({
      createPullRequest: {
        pullRequest: row(1, { headRepository: { nameWithOwner: "fork/repo" } }),
      },
    }),
  );
  await assert.rejects(
    adapter.createPullRequest({
      repository: "owner/repo",
      repositoryId: "REPO_1",
      branch: "feature",
      targetBranch: "main",
      title: "title",
      body: "body",
    }),
    /another repository/u,
  );
});

await test("continuation fetches only the candidate connection with more pages", async () => {
  let calls = 0;
  const adapter = new GitHubCodeHost("token", async (_args, options) => {
    const request = JSON.parse(options.input!) as {
      variables: Record<string, unknown>;
    };
    calls++;
    if (calls === 1)
      return envelope({
        repository: {
          ...repository,
          ref: { target: { oid: head } },
          source: page([row(1)]),
          target: page([row(1)], 2, "target-next"),
        },
      });
    assert.equal(request.variables.sourceMore, false);
    assert.equal(request.variables.targetMore, true);
    assert.equal(request.variables.targetAfter, "target-next");
    return envelope({
      repository: {
        ...repository,
        ref: { target: { oid: head } },
        target: page([row(2, { headRefName: "other" })], 2),
      },
    });
  });
  const result = await adapter.observePublication({
    repository: "owner/repo",
    branch: "feature",
    targetBranch: "main",
  });
  assert.deepEqual(
    result.candidates.map(({ id }) => id),
    ["PR_1", "PR_2"],
  );
});

await test("an inaccessible repository or missing ref field cannot establish an absent branch", async () => {
  for (const result of [
    null,
    { ...repository },
    { ...repository, ref: null, id: "" },
  ]) {
    const adapter = new GitHubCodeHost("token", async () =>
      envelope({ repository: result }),
    );
    await assert.rejects(
      adapter.observePublicationBranch("owner/repo", "feature"),
    );
  }
});
