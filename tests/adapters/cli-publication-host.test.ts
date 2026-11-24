import assert from "node:assert/strict";
import test from "node:test";
import { GitHubCodeHost } from "../../src/adapters/github-code-host.ts";
import { executeCli } from "../../src/cli.ts";
import { implementationCommand } from "../support/implementation-run.ts";
import { publicationRun } from "../support/publication-run.ts";

import {
  connection,
  createdAt,
  exact,
  head,
  publication,
  remote,
  repository,
} from "../support/github-pr-fixture.ts";

await test("publication sends the accepted multiline metadata directly and records the returned identity", async (t) => {
  const fixture = await publicationRun(t);
  const operations: string[] = [];
  let created: object | undefined;
  const polls: number[] = [];
  const adapter = new GitHubCodeHost(async (args, options) => {
    if (args[0] === "api" && args[1] === "--method")
      return JSON.stringify({ default_branch: "default-branch" });
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
        ...exact,
        headRefName: saved.branch,
        baseRefName: "default-branch",
        headRefOid: sha,
      };
      return JSON.stringify({
        data: { createPullRequest: { pullRequest: created } },
      });
    }
    assert.equal(variables.owner, "owner");
    assert.equal(variables.name, "repo");
    assert.equal(variables.ref, `refs/heads/${saved.branch}`);
    if (query.includes("pullRequest(number:")) {
      operations.push("poll");
      assert.equal(variables.number, 81);
      assert.doesNotMatch(query, /pullRequests\(/u);
      assert.deepEqual(saved.publication?.pullRequest, {
        id: "PR_exact",
        number: 81,
        url: "https://github.com/Owner/Repo/pull/81",
        createdAt,
      });
      polls.push(fixture.dependencies.clock.now().getTime());
      return JSON.stringify({
        data: {
          repository: {
            ...repository,
            ref,
            pullRequest: {
              ...created,
              mergedAt: null,
              mergeable: "UNKNOWN",
              mergeStateStatus: "BLOCKED",
              isInMergeQueue: false,
              isMergeQueueEnabled: true,
              autoMergeRequest: null,
              mergeQueueEntry: null,
              commits: {
                nodes: [
                  {
                    commit: {
                      oid: sha,
                      statusCheckRollup:
                        polls.length === 1
                          ? {
                              contexts: connection([
                                {
                                  __typename: "StatusContext",
                                  id: "SC_CI",
                                  context: "CI",
                                  state: "PENDING",
                                  createdAt,
                                  targetUrl: null,
                                  isRequired: true,
                                },
                              ]),
                            }
                          : null,
                    },
                  },
                ],
              },
            },
          },
        },
      });
    }
    if (!query.includes("pullRequests(")) {
      operations.push("branch");
      assert.equal(saved.publication, undefined);
      return JSON.stringify({ data: { repository: { ...repository, ref } } });
    }
    operations.push("publication");
    assert.equal(variables.branch, saved.branch);
    assert.equal(variables.base, "default-branch");
    return JSON.stringify({
      data: {
        repository: {
          ...repository,
          ref,
          source: connection([]),
          target: connection([]),
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
  assert.deepEqual(operations, [
    "branch",
    "publication",
    "create",
    "poll",
    "poll",
  ]);
  assert.deepEqual(polls, [40_000, 50_000]);
  assert.equal(
    (await fixture.snapshot()).publication?.repositoryId,
    repository.id,
  );
  const observedMerge = (await fixture.snapshot()).publication?.checksState;
  assert.equal(observedMerge?.mergeable, "unknown");
  assert.equal(observedMerge?.mergeStateStatus, "BLOCKED");
  assert.equal(observedMerge?.isMergeQueueEnabled, true);
});

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
  const adapter = new GitHubCodeHost((_args, { input }) => {
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
  const adapter = new GitHubCodeHost(() => {
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
  { id: "R_fork", nameWithOwner: repository.nameWithOwner },
  { nameWithOwner: "Fork/Repo" },
]) {
  await test(`publication rejects incomplete or contradictory head repository identity ${JSON.stringify(headRepository)}`, async () => {
    const adapter = new GitHubCodeHost(() =>
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
    const adapter = new GitHubCodeHost(() =>
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
    const adapter = new GitHubCodeHost(() =>
      Promise.resolve(JSON.stringify(reply)),
    );
    await assert.rejects(adapter.observePublication(publication), error);
  });
}
