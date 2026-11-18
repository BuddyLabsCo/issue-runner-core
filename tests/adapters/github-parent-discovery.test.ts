/* eslint-disable @typescript-eslint/require-await -- Scripted GitHub command. */
import assert from "node:assert/strict";
import test from "node:test";
import { GitHubTracker } from "../../src/adapters/github-tracker.ts";
import type { GitHubCommand } from "../../src/adapters/github-client.ts";

const repository = { id: "repo-id", nameWithOwner: "owner/repo" };
const reservation = { id: "reserved-id", name: "runner:reserved" };
const runner = { id: "runner-id", login: "runner" };
const config = {
  reservationLabel: reservation.name,
  runnerAccount: runner.login,
};

function issue(number: number, fields: Record<string, unknown> = {}) {
  return {
    id: `issue-${number}`,
    number,
    repository,
    state: "OPEN",
    stateReason: null,
    ...fields,
  };
}

function connection(
  nodes: object[],
  totalCount = nodes.length,
  cursor: string | null = null,
  hasNextPage = false,
) {
  return { nodes, totalCount, pageInfo: { hasNextPage, endCursor: cursor } };
}

function child(number: number, fields: Record<string, unknown> = {}) {
  return issue(number, {
    labels: connection([]),
    assignees: connection([]),
    blockedBy: connection([]),
    ...fields,
  });
}

function observation(subIssues: object) {
  return {
    data: {
      repository: {
        ...repository,
        label: reservation,
        issue: issue(48, { subIssues }),
      },
      user: runner,
    },
  };
}

await test("parent discovery returns complete facts and mutation IDs from one single-page query", async () => {
  let requests = 0;
  const command: GitHubCommand = async (args, { input }) => {
    requests++;
    assert.deepEqual(args, [
      "api",
      "graphql",
      "--method",
      "POST",
      "--input",
      "-",
    ]);
    const { query } = JSON.parse(input!) as { query: string };
    for (const field of [
      "subIssues",
      "labels",
      "assignees",
      "blockedBy",
      "user",
      "label",
    ])
      assert.match(query, new RegExp(`\\b${field}\\(`, "u"));
    return JSON.stringify(
      observation(
        connection(
          [
            child(51, {
              labels: connection([reservation], 1, "label-end"),
              assignees: connection([runner], 1, "assignee-end"),
              blockedBy: connection(
                [
                  issue(99, {
                    repository: {
                      id: "outside-id",
                      nameWithOwner: "outside/repo",
                    },
                    state: "CLOSED",
                    stateReason: "NOT_PLANNED",
                  }),
                ],
                1,
                "blocker-end",
              ),
            }),
          ],
          1,
          "child-end",
        ),
      ),
    );
  };
  const facts = await new GitHubTracker("fake-token", command).discoverParent(
    repository.nameWithOwner,
    48,
    config,
  );
  assert.equal(requests, 1);
  assert.deepEqual(facts, {
    parent: {
      id: "issue-48",
      number: 48,
      repository: "owner/repo",
      repositoryId: "repo-id",
      state: "open",
      stateReason: null,
    },
    children: [
      {
        id: "issue-51",
        number: 51,
        repository: "owner/repo",
        repositoryId: "repo-id",
        state: "open",
        stateReason: null,
        labels: [reservation],
        assignees: [runner],
        blockers: [
          {
            id: "issue-99",
            number: 99,
            repository: "outside/repo",
            repositoryId: "outside-id",
            state: "closed",
            stateReason: "not_planned",
          },
        ],
      },
    ],
    reservation,
    runner,
  });
});

await test("discovery drains child and eligibility pages independently by node ID", async () => {
  const first = child(51, {
    labels: connection([reservation], 2, "shared", true),
    assignees: connection([runner], 2, "shared", true),
    blockedBy: connection([issue(91)], 3, "shared", true),
  });
  const second = child(52, {
    labels: connection([], 1, "shared", true),
  });
  const ready = { id: "ready-id", name: "ready-for-agent" };
  const external = { id: "external-id", login: "developer" };
  const pages = new Map([
    [
      "issue-48:subIssues:shared",
      connection([first, second], 2, "children-end"),
    ],
    [
      "issue-51:labels:shared",
      connection([reservation, ready], 2, "labels-end"),
    ],
    ["issue-51:assignees:shared", connection([external], 2, "assignees-end")],
    [
      "issue-51:blockedBy:shared",
      connection([issue(92)], 3, "blockers-next", true),
    ],
    [
      "issue-51:blockedBy:blockers-next",
      connection([issue(93)], 3, "blockers-end"),
    ],
    ["issue-52:labels:shared", connection([ready], 1, "labels-end")],
  ]);
  const command: GitHubCommand = async (_args, { input }) => {
    const { query, variables } = JSON.parse(input!) as {
      query: string;
      variables: { owner: string; after?: string };
    };
    if (query.includes("query ParentDiscovery"))
      return JSON.stringify(
        observation(connection([first], 2, "shared", true)),
      );
    const field =
      /\b(subIssues|labels|assignees|blockedBy)\(first: \d+, after: \$after\)/u.exec(
        query,
      )?.[1];
    const key = `${variables.owner}:${field}:${variables.after}`;
    const page = pages.get(key);
    assert.ok(page, key);
    pages.delete(key);
    return JSON.stringify({
      data: { node: { id: variables.owner, [field!]: page } },
    });
  };

  const { children } = await new GitHubTracker(
    "fake-token",
    command,
  ).discoverParent(repository.nameWithOwner, 48, config);
  assert.deepEqual(
    children.map(({ number, labels, assignees, blockers }) => ({
      number,
      labels,
      assignees,
      blockers: blockers.map((blocker) => blocker.number),
    })),
    [
      {
        number: 51,
        labels: [reservation, ready],
        assignees: [runner, external],
        blockers: [91, 92, 93],
      },
      { number: 52, labels: [ready], assignees: [], blockers: [] },
    ],
  );
  assert.equal(pages.size, 0);
});

await test("discovery rejects a cyclic cursor even after observing an open blocker", async () => {
  const first = connection([issue(91)], 2, "cycle", true);
  const command: GitHubCommand = async (_args, { input }) => {
    const { query } = JSON.parse(input!) as { query: string };
    return JSON.stringify(
      query.includes("query ParentDiscovery")
        ? observation(connection([child(51, { blockedBy: first })]))
        : {
            data: {
              node: {
                id: "issue-51",
                blockedBy: connection([issue(92)], 2, "cycle"),
              },
            },
          },
    );
  };

  await assert.rejects(
    new GitHubTracker("fake-token", command).discoverParent(
      repository.nameWithOwner,
      48,
      config,
    ),
    /invalid blockedBy cursor/u,
  );
});

await test("discovery rejects partial GraphQL output with a required field error", async () => {
  const command: GitHubCommand = async () => ({
    stdout: JSON.stringify({
      ...observation(connection([child(51)])),
      errors: [
        {
          message: "blocker access denied",
          path: ["repository", "issue", "subIssues", "nodes", 0, "blockedBy"],
        },
      ],
    }),
    error: new Error("gh exited unsuccessfully"),
  });
  await assert.rejects(
    new GitHubTracker("fake-token", command).discoverParent(
      repository.nameWithOwner,
      48,
      config,
    ),
    /blocker access denied/u,
  );
});

for (const [name, facts, message] of [
  ["null labels", child(51, { labels: null }), /Expected a JSON object/u],
  [
    "truncated assignees",
    child(51, { assignees: connection([], 1) }),
    /incomplete assignees/u,
  ],
  [
    "missing blocker cursor",
    child(51, { blockedBy: connection([], 1, null, true) }),
    /invalid blockedBy cursor/u,
  ],
  [
    "foreign child",
    child(51, {
      repository: { id: "foreign-id", nameWithOwner: "outside/repo" },
    }),
    /cross-repository child/u,
  ],
  [
    "unsupported closed child",
    child(51, { state: "CLOSED", stateReason: "DUPLICATE" }),
    /unsupported terminal state/u,
  ],
  [
    "closed blocker with no reason",
    child(51, { blockedBy: connection([issue(91, { state: "CLOSED" })]) }),
    /unsupported terminal state/u,
  ],
] as const) {
  await test(`discovery rejects ${name}`, async () => {
    const command: GitHubCommand = async () =>
      JSON.stringify(observation(connection([facts])));
    await assert.rejects(
      new GitHubTracker("fake-token", command).discoverParent(
        repository.nameWithOwner,
        48,
        config,
      ),
      message,
    );
  });
}
