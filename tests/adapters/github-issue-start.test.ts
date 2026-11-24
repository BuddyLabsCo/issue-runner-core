/* eslint-disable @typescript-eslint/require-await -- Scripted GitHub command. */
import assert from "node:assert/strict";
import test from "node:test";
import { GitHubTracker } from "../../src/adapters/github-tracker.ts";
import {
  child,
  config,
  connection,
  issue,
  repository,
  reservation,
  runner,
} from "../support/github-parent-discovery.ts";

await test("standalone start reads its own Issue and confirms grouped additive markers across pages", async () => {
  const extraLabel = { id: "extra", name: "ready" };
  const target = child(51, {
    title: "Task",
    body: "",
    url: "https://github.com/owner/repo/issues/51",
  });
  let requests = 0;
  const tracker = new GitHubTracker(async (_args, { input }) => {
    const { query, variables } = JSON.parse(input!) as {
      query: string;
      variables: unknown;
    };
    switch (++requests) {
      case 1:
        assert.match(query, /blockedBy/u);
        assert.doesNotMatch(query, /\b(?:parent|subIssues)\b/u);
        assert.match(query, /\bviewer\s*\{\s*id login\s*\}/u);
        assert.doesNotMatch(query, /\buser\b/u);
        assert.deepEqual(variables, {
          owner: "OWNER",
          name: "Repo",
          number: 51,
          reservation: reservation.name,
        });
        return JSON.stringify({
          data: {
            repository: { ...repository, label: reservation, target },
            viewer: runner,
          },
        });
      case 2: {
        assert.match(
          query,
          /addLabelsToLabelable[\s\S]+addAssigneesToAssignable/u,
        );
        const finalSelection = query.slice(query.indexOf("addRunner:"));
        assert.match(finalSelection, /assignable\s*\{/u);
        assert.match(
          finalSelection,
          /labels\(first: 100\)\s*\{\s*nodes\s*\{\s*id name\s*\}\s*totalCount\s*pageInfo\s*\{\s*hasNextPage endCursor\s*\}\s*\}/u,
        );
        assert.match(
          finalSelection,
          /assignees\(first: 100\)\s*\{\s*nodes\s*\{\s*id login\s*\}\s*totalCount\s*pageInfo\s*\{\s*hasNextPage endCursor\s*\}\s*\}/u,
        );
        assert.deepEqual(variables, {
          issue: "issue-51",
          label: reservation.id,
          viewer: runner.id,
        });
        return JSON.stringify({
          data: {
            addReservation: { labelable: target },
            addRunner: {
              assignable: child(51, {
                labels: connection([extraLabel], 2, "next-label", true),
                assignees: connection([runner]),
              }),
            },
          },
        });
      }
      case 3:
        assert.match(query, /labels\(first: 100, after: \$after\)/u);
        assert.deepEqual(variables, { owner: "issue-51", after: "next-label" });
        return JSON.stringify({
          data: {
            node: { id: "issue-51", labels: connection([reservation], 2) },
          },
        });
      default:
        assert.fail("unexpected GitHub request");
    }
  });
  const facts = await tracker.readIssueStart("OWNER/Repo", 51, config);
  assert.equal(facts.issue.title, "Task");
  assert.equal(facts.issue.repository, repository.nameWithOwner);
  assert.equal(facts.scope, undefined);
  assert.deepEqual(facts.viewer, runner);
  const confirmed = await tracker.reserveIssue({
    issue: facts.issue,
    reservation,
    viewer: runner,
    addLabel: true,
    addRunner: true,
  });
  assert.deepEqual(confirmed.labels, [extraLabel, reservation]);
  assert.deepEqual(confirmed.assignees, [runner]);
  assert.equal(requests, 3);
});

await test("parent-scoped start drains parent membership independently of target blockers", async () => {
  const target = child(51, {
    title: "Task",
    body: "",
    url: "https://github.com/owner/repo/issues/51",
    blockedBy: connection(
      [issue(30, { state: "CLOSED", stateReason: "COMPLETED" })],
      2,
      "blockers",
      true,
    ),
  });
  const cursors: string[] = [];
  const tracker = new GitHubTracker(async (_args, { input }) => {
    const { query, variables } = JSON.parse(input!) as {
      query: string;
      variables: { parent?: number; owner: string; after?: string };
    };
    if (variables.after === undefined) {
      assert.equal(variables.parent, 48);
      assert.match(query, /configuredParent: issue\(number: \$parent\)/u);
      return JSON.stringify({
        data: {
          repository: {
            ...repository,
            label: reservation,
            target,
            configuredParent: issue(48, {
              subIssues: connection([issue(52)], 2, "children", true),
            }),
          },
          viewer: runner,
        },
      });
    }
    const { owner, after } = variables;
    cursors.push(after);
    if (owner === "issue-48") {
      assert.equal(after, "children");
      return JSON.stringify({
        data: { node: { id: owner, subIssues: connection([issue(51)], 2) } },
      });
    }
    assert.equal(owner, "issue-51");
    assert.equal(after, "blockers");
    return JSON.stringify({
      data: { node: { id: owner, blockedBy: connection([issue(31)], 2) } },
    });
  });
  const facts = await tracker.readIssueStart(
    repository.nameWithOwner,
    51,
    config,
    48,
  );
  assert.deepEqual(cursors.sort(), ["blockers", "children"]);
  assert.deepEqual(
    facts.scope?.children.map(({ number }) => number),
    [52, 51],
  );
  assert.deepEqual(
    facts.issue.blockers.map(({ state }) => state),
    ["closed", "open"],
  );
});

const payload = child(51, {
  labels: connection([reservation]),
  assignees: connection([runner]),
});
const startIssue = {
  id: "issue-51",
  number: 51,
  repository: repository.nameWithOwner,
  repositoryId: repository.id,
  state: "open",
  stateReason: null,
} as const;

for (const [alias, data] of [
  [
    "addReservation",
    { addReservation: null, addRunner: { assignable: payload } },
  ],
  ["addRunner", { addReservation: { labelable: payload }, addRunner: null }],
  ["addRunner", null],
] as const) {
  await test("a failed GraphQL command retains Reservation data and alias errors", async () => {
    const errors = [{ message: "write uncertain", path: [alias] }];
    const response = { data, errors };
    const tracker = new GitHubTracker(async () => ({
      stdout: JSON.stringify(response),
      error: new Error("gh failed"),
      exitCode: 1,
    }));
    await assert.rejects(
      tracker.reserveIssue({
        issue: startIssue,
        reservation,
        viewer: runner,
        addLabel: true,
        addRunner: true,
      }),
      (error: unknown) => {
        assert.ok(error instanceof Error);
        assert.match(error.message, /write uncertain/u);
        assert.ok("response" in error);
        assert.deepEqual(error.response, response);
        return true;
      },
    );
  });
}

await test("a valid final payload cannot confirm a grouped write when the first payload is missing", async () => {
  const tracker = new GitHubTracker(async () =>
    JSON.stringify({ data: { addRunner: { assignable: payload } } }),
  );
  await assert.rejects(
    tracker.reserveIssue({
      issue: startIssue,
      reservation,
      viewer: runner,
      addLabel: true,
      addRunner: true,
    }),
    /Reservation was not confirmed/u,
  );
});

await test("label-only confirmation returns all paginated assignees to the workflow", async () => {
  let requests = 0;
  const external = { id: "external", login: "developer" };
  const tracker = new GitHubTracker(async (_args, { input }) => {
    const { query, variables } = JSON.parse(input!) as {
      query: string;
      variables: unknown;
    };
    if (++requests === 1) {
      assert.match(query, /addLabelsToLabelable/u);
      assert.doesNotMatch(query, /addAssigneesToAssignable/u);
      assert.deepEqual(variables, { issue: "issue-51", label: reservation.id });
      return JSON.stringify({
        data: {
          addReservation: {
            labelable: {
              ...payload,
              assignees: connection([runner], 2, "more", true),
            },
          },
        },
      });
    }
    assert.deepEqual(variables, { owner: "issue-51", after: "more" });
    return JSON.stringify({
      data: {
        node: {
          id: "issue-51",
          assignees: connection([external], 2),
        },
      },
    });
  });
  assert.deepEqual(
    await tracker.reserveIssue({
      issue: startIssue,
      reservation,
      viewer: runner,
      addLabel: true,
      addRunner: false,
    }),
    { labels: [reservation], assignees: [runner, external] },
  );
  assert.equal(requests, 2);
});
