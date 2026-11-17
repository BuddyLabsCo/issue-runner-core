/* eslint-disable @typescript-eslint/require-await -- Scripted GitHub boundary. */
import assert from "node:assert/strict";
import test from "node:test";
import { GitHubTracker } from "../../src/adapters/github-tracker.ts";

const repository = { id: "repo", nameWithOwner: "owner/repo" };
const connection = (nodes: unknown[]) => ({
  nodes,
  pageInfo: { hasNextPage: false, endCursor: null },
});
const issue = {
  id: "issue",
  number: 2,
  state: "OPEN",
  stateReason: null,
  repository,
  title: "Issue",
  body: "",
  url: "https://example.com/2",
  labels: connection([{ id: "ready", name: "ready" }]),
  assignees: connection([]),
  blockedBy: connection([]),
};

await test("start observation returns complete standalone facts and mutation IDs", async () => {
  const tracker = new GitHubTracker("secret", async () =>
    JSON.stringify({
      data: {
        repository: {
          ...repository,
          target: issue,
          label: { id: "label", name: "reserved" },
        },
        user: { id: "runner", login: "bot" },
      },
    }),
  );
  const result = await tracker.observeStart({
    repository: "owner/repo",
    number: 2,
    runner: "bot",
    label: "reserved",
  });
  assert.deepEqual(result.ticket.labels, ["ready"]);
  assert.equal(result.labelId, "label");
  assert.equal(result.runnerId, "runner");
});

await test("combined Reservation confirms returned markers and preserves partial errors", async () => {
  for (const partial of [false, true]) {
    const calls: string[] = [];
    const reserved = {
      ...issue,
      labels: connection([
        { id: "ready", name: "ready" },
        { id: "label", name: "reserved" },
      ]),
      assignees: connection([{ id: "runner", login: "bot" }]),
    };
    const tracker = new GitHubTracker("secret", async (_args, options) => {
      const input = JSON.parse(options.input!) as { query: string };
      calls.push(input.query);
      return JSON.stringify({
        data: {
          addReservation: { labelable: reserved },
          addRunner: partial ? null : { assignable: reserved },
        },
        ...(partial
          ? { errors: [{ message: "denied", path: ["addRunner"] }] }
          : {}),
      });
    });
    const action = tracker.reserveStart({
      ticket: {
        id: "issue",
        number: 2,
        state: "open",
        stateReason: null,
        repository: "owner/repo",
        repositoryId: "repo",
      },
      labelId: "label",
      runnerId: "runner",
      label: "reserved",
      runner: "bot",
    });
    if (partial)
      await assert.rejects(action, (error: Error) => error.cause !== undefined);
    else assert.deepEqual((await action).assignees, ["bot"]);
    assert.equal(calls.length, 1);
    assert.match(calls[0]!, /addLabelsToLabelable/u);
    assert.match(calls[0]!, /addAssigneesToAssignable/u);
  }
});

await test("start observation drains scoped children and target marker pages before returning", async () => {
  const more = (nodes: unknown[], cursor: string) => ({
    nodes,
    pageInfo: { hasNextPage: true, endCursor: cursor },
  });
  const parent = {
    id: "parent",
    number: 1,
    state: "OPEN",
    stateReason: null,
    repository,
  };
  const tracker = new GitHubTracker("secret", async (_args, options) => {
    const { variables } = JSON.parse(options.input!) as {
      variables: { id?: string; after?: string };
    };
    if (!variables.id)
      return JSON.stringify({
        data: {
          repository: {
            ...repository,
            target: {
              ...issue,
              labels: more([{ id: "ready", name: "ready" }], "labels-next"),
            },
            label: { id: "label", name: "reserved" },
            parent: {
              ...parent,
              subIssues: more([{ ...issue }], "children-next"),
            },
          },
          user: { id: "runner", login: "bot" },
        },
      });
    if (variables.id === "issue")
      return JSON.stringify({
        data: {
          node: {
            id: "issue",
            labels: connection([{ id: "other", name: "other" }]),
          },
        },
      });
    return JSON.stringify({
      data: {
        node: {
          id: "parent",
          subIssues: connection([{ ...parent, id: "sibling", number: 3 }]),
        },
      },
    });
  });
  const result = await tracker.observeStart({
    repository: "owner/repo",
    number: 2,
    parent: 1,
    runner: "bot",
    label: "reserved",
  });
  assert.deepEqual(result.ticket.labels, ["ready", "other"]);
  assert.deepEqual(
    result.children!.map((child) => child.number),
    [2, 3],
  );
});

await test("an incomplete Reservation confirmation cannot establish ownership", async () => {
  const tracker = new GitHubTracker("secret", async () =>
    JSON.stringify({
      data: {
        addReservation: { labelable: null },
        addRunner: { assignable: issue },
      },
    }),
  );
  await assert.rejects(
    tracker.reserveStart({
      ticket: {
        id: "issue",
        number: 2,
        state: "open",
        stateReason: null,
        repository: "owner/repo",
        repositoryId: "repo",
      },
      labelId: "label",
      runnerId: "runner",
      label: "reserved",
      runner: "bot",
    }),
    /incomplete/u,
  );
});
