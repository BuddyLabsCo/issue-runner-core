import assert from "node:assert/strict";
import test from "node:test";
import { GitHubCodeHost } from "../../src/adapters/github-code-host.ts";
import { executeCli } from "../../src/cli.ts";
import { implementationCommand } from "../support/implementation-run.ts";
import { publicationRun } from "../support/publication-run.ts";

const nameWithOwner = "Owner/Repo";
const repository = { id: "R_repo", nameWithOwner };
const createdAt = "2026-11-18T12:00:00Z";

function connection(
  nodes: unknown[],
  totalCount = nodes.length,
  next: string | null = null,
) {
  return {
    nodes,
    totalCount,
    pageInfo: { hasNextPage: next !== null, endCursor: next },
  };
}

await test("publication sends the accepted multiline metadata directly and records the returned identity", async (t) => {
  const fixture = await publicationRun(t);
  const operations: string[] = [];
  let created: object | undefined;
  const adapter = new GitHubCodeHost("host-secret", async (args, options) => {
    assert.equal(options.token, "host-secret");
    if (args[0] === "api" && args[1] === "--method")
      return JSON.stringify({ default_branch: "default-branch" });
    if (args[1] === "checks") {
      assert.ok(args.includes("--required"));
      assert.deepEqual(options.allowedExitCodes, [1, 8]);
      return "[]";
    }
    assert.deepEqual(args, [
      "api",
      "graphql",
      "--method",
      "POST",
      "--input",
      "-",
    ]);
    const { query, variables } = JSON.parse(options.input!) as {
      query: string;
      variables: Record<string, unknown>;
    };
    const saved = await fixture.snapshot();
    const sha = fixture.publicationState.branches.get(saved.branch);
    const ref = sha ? { name: saved.branch, target: { oid: sha } } : null;
    if (query.startsWith("mutation")) {
      operations.push("create");
      assert.equal(saved.publication?.phase, "pending_pr");
      assert.equal(saved.publication.creationAttempted, true);
      assert.equal(fixture.publicationState.pushes, 1);
      assert.deepEqual(variables.input, {
        repositoryId: repository.id,
        headRefName: saved.branch,
        baseRefName: "default-branch",
        title: saved.pr_title,
        body: "Implement the Issue.\n\nCloses #50",
        draft: false,
        maintainerCanModify: true,
      });
      created = {
        id: "PR_exact",
        number: 81,
        url: "https://github.com/Owner/Repo/pull/81",
        headRefName: saved.branch,
        baseRefName: "default-branch",
        headRefOid: sha,
        repository,
        headRepository: repository,
        state: "OPEN",
        isDraft: false,
        createdAt,
      };
      return JSON.stringify({
        data: { createPullRequest: { pullRequest: created } },
      });
    }
    assert.equal(variables.owner, "owner");
    assert.equal(variables.name, "repo");
    assert.equal(variables.ref, `refs/heads/${saved.branch}`);
    if (!query.includes("pullRequests(")) {
      operations.push("branch");
      assert.equal(saved.publication, undefined);
      return JSON.stringify({ data: { repository: { ...repository, ref } } });
    }
    operations.push("publication");
    assert.equal(variables.branch, saved.branch);
    assert.equal(variables.base, "default-branch");
    if (created) {
      assert.ok(fixture.state.sleeps.includes(30_000));
      assert.deepEqual((await fixture.snapshot()).publication?.pullRequest, {
        id: "PR_exact",
        number: 81,
        url: "https://github.com/Owner/Repo/pull/81",
        createdAt,
      });
    }
    const candidates = created ? [created] : [];
    return JSON.stringify({
      data: {
        repository: {
          ...repository,
          ref,
          source: connection(candidates),
          target: connection(candidates),
        },
      },
    });
  });
  const result = await executeCli(
    [...implementationCommand, "--no-auto-merge"],
    { ...fixture.dependencies, codeHost: adapter },
  );
  assert.match(
    result.summary.tickets![0]!.detail,
    /CI-ready/u,
    JSON.stringify(result),
  );
  assert.deepEqual(operations.slice(0, 3), ["branch", "publication", "create"]);
  assert.equal(
    operations.filter((operation) => operation === "create").length,
    1,
  );
  assert.equal(
    (await fixture.snapshot()).publication?.repositoryId,
    repository.id,
  );
});

const publication = {
  repository: "owner/repo",
  branch: "runner/issue",
  targetBranch: "main",
};
const head = "a".repeat(40);
const remote = {
  ...repository,
  ref: { name: publication.branch, target: { oid: head } },
};
const exact = {
  id: "PR_exact",
  number: 81,
  url: "https://github.com/Owner/Repo/pull/81",
  headRefName: publication.branch,
  baseRefName: publication.targetBranch,
  headRefOid: head,
  repository,
  headRepository: repository,
  state: "OPEN",
  isDraft: false,
  createdAt,
};
const closed = {
  ...exact,
  id: "PR_closed",
  number: 82,
  url: "https://github.com/Owner/Repo/pull/82",
  headRefName: "other-source",
  state: "CLOSED",
};
const fork = {
  ...exact,
  id: "PR_fork",
  number: 83,
  url: "https://github.com/Owner/Repo/pull/83",
  headRepository: { id: "R_fork", nameWithOwner: "Fork/Repo" },
};

await test("publication completes each candidate connection and counts a shared PR only once", async () => {
  const replies = [
    {
      cursors: [null, null, true, true],
      source: connection([exact], 2, "source-1"),
      target: connection([fork], 3, "target-1"),
    },
    {
      cursors: ["source-1", "target-1", true, true],
      source: connection([fork], 2),
      target: connection([exact], 3, "target-2"),
    },
    {
      cursors: ["source-1", "target-2", false, true],
      target: connection([closed], 3),
    },
  ];
  const adapter = new GitHubCodeHost("host-secret", (_args, { input }) => {
    const { query, variables } = JSON.parse(input!) as {
      query: string;
      variables: Record<string, unknown>;
    };
    const { cursors, ...reply } = replies.shift()!;
    assert.match(
      query,
      /headRefName: \$branch, states: \[OPEN, CLOSED, MERGED\]/u,
    );
    assert.match(
      query,
      /baseRefName: \$base, states: \[OPEN, CLOSED, MERGED\]/u,
    );
    assert.deepEqual(
      [
        variables.headAfter,
        variables.baseAfter,
        variables.source,
        variables.target,
      ],
      cursors,
    );
    return Promise.resolve(
      JSON.stringify({ data: { repository: { ...remote, ...reply } } }),
    );
  });
  const observed = await adapter.observePublication(publication);
  assert.equal(observed.repositoryId, repository.id);
  assert.equal(observed.headSha, head);
  assert.deepEqual(
    observed.candidates.map(({ id, state }) => [id, state]),
    [
      ["PR_exact", "open"],
      ["PR_closed", "closed"],
    ],
  );
  assert.equal(replies.length, 0);
});

await test("publication cancellation stops candidate pagination before the next request", async () => {
  const controller = new AbortController();
  let requests = 0;
  const adapter = new GitHubCodeHost("host-secret", () => {
    if (++requests > 1) assert.fail("unexpected continuation request");
    controller.abort();
    return Promise.resolve(
      JSON.stringify({
        data: {
          repository: {
            ...remote,
            source: connection([exact], 2, "source-1"),
            target: connection([exact]),
          },
        },
      }),
    );
  });
  await assert.rejects(
    adapter.observePublication(publication, controller.signal),
    { name: "AbortError" },
  );
  assert.equal(requests, 1);
});

for (const headRepository of [
  { id: repository.id, nameWithOwner: "Fork/Repo" },
  { id: "R_fork", nameWithOwner },
  { nameWithOwner: "Fork/Repo" },
]) {
  await test(`publication rejects incomplete or contradictory head repository identity ${JSON.stringify(headRepository)}`, async () => {
    const adapter = new GitHubCodeHost("host-secret", () =>
      Promise.resolve(
        JSON.stringify({
          data: {
            repository: {
              ...remote,
              source: connection([{ ...exact, headRepository }]),
              target: connection([]),
            },
          },
        }),
      ),
    );
    await assert.rejects(
      adapter.observePublication(publication),
      /unexpected head repository ID/u,
    );
  });
}

for (const { name, response, error } of [
  {
    name: "an absent repository",
    response: { repository: null },
    error: /Expected a JSON object/u,
  },
  {
    name: "an unexpected repository",
    response: {
      repository: { ...repository, nameWithOwner: "Other/Repo", ref: null },
    },
    error: /unexpected publication repository/u,
  },
  {
    name: "a missing ref field",
    response: { repository },
    error: /Expected a JSON object/u,
  },
]) {
  await test(`pre-push observation rejects ${name}`, async () => {
    const adapter = new GitHubCodeHost("host-secret", () =>
      Promise.resolve(JSON.stringify({ data: response })),
    );
    await assert.rejects(
      adapter.observeBranch(publication.repository, publication.branch),
      error,
    );
  });
}

for (const { name, reply, error } of [
  {
    name: "GraphQL errors accompanying data",
    reply: {
      data: {
        repository: {
          ...remote,
          source: connection([]),
          target: connection([]),
        },
      },
      errors: [{ message: "partial result" }],
    },
    error: /incomplete publication data/u,
  },
  {
    name: "an omitted connection",
    reply: { data: { repository: { ...remote, source: connection([]) } } },
    error: /Expected a JSON object/u,
  },
  {
    name: "a truncated final page",
    reply: {
      data: {
        repository: {
          ...remote,
          source: connection([]),
          target: connection([exact], 2),
        },
      },
    },
    error: /incomplete Pull Request pages/u,
  },
]) {
  await test(`combined publication observation rejects ${name}`, async () => {
    const adapter = new GitHubCodeHost("host-secret", () =>
      Promise.resolve(JSON.stringify(reply)),
    );
    await assert.rejects(adapter.observePublication(publication), error);
  });
}
