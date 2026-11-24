/* eslint-disable @typescript-eslint/require-await -- Scripted GitHub command. */
import assert from "node:assert/strict";
import test from "node:test";
import { GitHubTracker } from "../../src/adapters/github-tracker.ts";
import type { GitHubCommand } from "../../src/adapters/github-client.ts";
import {
  child,
  config,
  connection,
  issue,
  observation,
  repository,
  reservation,
  runner,
} from "../support/github-parent-discovery.ts";

function assertDiscoveryRequest({
  query,
  variables,
}: {
  query: string;
  variables: unknown;
}) {
  assert.deepEqual(variables, {
    owner: "owner",
    name: "repo",
    number: 48,
    reservation: "runner:reserved",
  });
  const fields = new Map<string, Record<string, string>>();
  const parents: string[] = [];
  // This query uses named fields, variable or integer arguments, and nested selections.
  for (const [, field, args = "", nested, close] of query
    .slice(query.indexOf("{") + 1)
    .matchAll(/(\w+)(?:\s*\(([^()]*)\))?\s*(\{)?|(\})/gu)) {
    if (close) {
      parents.pop();
      continue;
    }
    const path = [...parents, field].join(".");
    fields.set(
      path,
      Object.fromEntries<string>(
        [...args.matchAll(/(\w+)\s*:\s*(\$?\w+)/gu)].map(([, key, value]) => [
          key!,
          value!,
        ]),
      ),
    );
    if (nested) parents.push(field!);
  }
  const parent = "repository.issue";
  const children = `${parent}.subIssues`;
  const child = `${children}.nodes`;
  const blockers = `${child}.blockedBy`;
  const identity = [
    "id",
    "number",
    "state",
    "stateReason",
    "repository.id",
    "repository.nameWithOwner",
  ];
  for (const path of [
    "repository.id",
    "repository.nameWithOwner",
    "repository.label.id",
    "repository.label.name",
    "viewer.id",
    "viewer.login",
    `${child}.labels.nodes.id`,
    `${child}.labels.nodes.name`,
    `${child}.assignees.nodes.id`,
    `${child}.assignees.nodes.login`,
    ...[parent, child, `${blockers}.nodes`].flatMap((owner) =>
      identity.map((field) => `${owner}.${field}`),
    ),
  ])
    assert.ok(fields.has(path), `missing selection ${path}`);
  for (const connection of [
    children,
    `${child}.labels`,
    `${child}.assignees`,
    blockers,
  ]) {
    assert.match(
      fields.get(connection)?.first ?? "",
      /^[1-9]\d*$/u,
      `missing page size for ${connection}`,
    );
    for (const field of [
      "totalCount",
      "pageInfo.hasNextPage",
      "pageInfo.endCursor",
    ])
      assert.ok(
        fields.has(`${connection}.${field}`),
        `missing selection ${connection}.${field}`,
      );
  }
  assert.deepEqual(fields.get("repository"), {
    owner: "$owner",
    name: "$name",
  });
  assert.deepEqual(fields.get(parent), { number: "$number" });
  assert.deepEqual(fields.get("repository.label"), { name: "$reservation" });
  assert.deepEqual(fields.get("viewer"), {});
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
    assertDiscoveryRequest(
      JSON.parse(input!) as { query: string; variables: unknown },
    );
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
  const facts = await new GitHubTracker(command).discoverParent(
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
    viewer: runner,
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
      connection([issue(93)], 3, "blockers-next-again", true),
    ],
    ["issue-51:blockedBy:blockers-next-again", connection([], 3)],
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

  const { children } = await new GitHubTracker(command).discoverParent(
    repository.nameWithOwner,
    48,
    config,
  );
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
    new GitHubTracker(command).discoverParent(
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
    new GitHubTracker(command).discoverParent(
      repository.nameWithOwner,
      48,
      config,
    ),
    /blocker access denied/u,
  );
});

await test("discovery rejects a missing authenticated viewer with a clear error", async () => {
  const command: GitHubCommand = async () => ({
    stdout: JSON.stringify({
      data: { ...observation(connection([])).data, viewer: null },
      errors: [
        {
          type: "FORBIDDEN",
          path: ["viewer"],
          message: "viewer unavailable",
        },
      ],
    }),
    error: new Error("gh failed"),
    exitCode: 1,
  });
  await assert.rejects(
    new GitHubTracker(command).discoverParent("owner/repo", 48, config),
    /normal GitHub user/u,
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
      new GitHubTracker(command).discoverParent(
        repository.nameWithOwner,
        48,
        config,
      ),
      message,
    );
  });
}

for (const [name, duplicate, error] of [
  [
    "a null blocker page",
    child(51, { blockedBy: null }),
    /Expected a JSON object/u,
  ],
  [
    "conflicting blockers",
    child(51, { blockedBy: connection([issue(52)]) }),
    /conflicting.*subIssues/u,
  ],
  [
    "conflicting assignees",
    child(51, { assignees: connection([runner]) }),
    /conflicting.*subIssues/u,
  ],
] as const) {
  await test(`discovery rejects a repeated child with ${name}`, async () => {
    let requests = 0;
    const command: GitHubCommand = async () =>
      JSON.stringify(
        requests++ === 0
          ? observation(connection([child(51)], 1, "child-first", true))
          : {
              data: {
                node: { id: "issue-48", subIssues: connection([duplicate]) },
              },
            },
      );
    await assert.rejects(
      new GitHubTracker(command).discoverParent("owner/repo", 48, config),
      error,
    );
    assert.equal(requests, 2);
  });
}

await test("discovery rejects a nonempty final continuation with a null end cursor", async () => {
  let requests = 0;
  const command: GitHubCommand = async () =>
    JSON.stringify(
      requests++ === 0
        ? observation(connection([child(51)], 2, "child-first", true))
        : {
            data: {
              node: {
                id: "issue-48",
                subIssues: connection([child(52)], 2, null),
              },
            },
          },
    );
  await assert.rejects(
    new GitHubTracker(command).discoverParent("owner/repo", 48, config),
    /invalid subIssues cursor/u,
  );
  assert.equal(requests, 2);
});
