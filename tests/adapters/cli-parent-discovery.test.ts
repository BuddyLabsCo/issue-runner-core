/* eslint-disable @typescript-eslint/require-await -- Scripted GitHub command. */
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { GitHubTracker } from "../../src/adapters/github-tracker.ts";
import type { GitHubCommand } from "../../src/adapters/github-client.ts";
import { executeCli } from "../../src/cli.ts";
import { createCliDependencies } from "../support/cli-dependencies.ts";
import { createProject, validConfig } from "../support/cli-project.ts";
import {
  child as workflowChild,
  parentDeliveryRun,
} from "../support/parent-run.ts";
import {
  child,
  config,
  connection,
  issue,
  observation,
  reservation,
  runnerNotFound,
} from "../support/github-parent-discovery.ts";

await test("parent completion uses a final scope scan and confirms closure from the mutation response", async (t) => {
  const { root } = await createProject(t, { ...validConfig, tracker: config });
  const dependencies = createCliDependencies(root);
  const state = { state: "CLOSED", stateReason: "NOT_PLANNED" };
  const cancelledChild = child(51, state);
  const requests: string[] = [];
  const command: GitHubCommand = async (args, { input }) => {
    assert.equal(args[1], "graphql");
    const { query, variables } = JSON.parse(input!) as {
      query: string;
      variables: Record<string, unknown>;
    };
    const subIssues = connection([cancelledChild]);
    if (query.includes("query ParentDiscovery")) {
      requests.push("discover");
      return JSON.stringify(observation(subIssues));
    }
    assert.match(query, /\bsubIssues\b/u);
    assert.doesNotMatch(query, /\b(blockedBy|labels?|assignees|user)\b/u);
    if (query.includes("closeIssue")) {
      requests.push("close");
      assert.deepEqual(Object.values(variables), ["issue-48"]);
      assert.match(query, /stateReason:\s*COMPLETED/u);
      return JSON.stringify({
        data: {
          closeIssue: {
            issue: issue(48, {
              state: "CLOSED",
              stateReason: "COMPLETED",
              subIssues,
            }),
          },
        },
      });
    }
    requests.push("scan");
    return JSON.stringify(observation(subIssues));
  };
  const result = await executeCli(
    ["run", "--project", "demo", "--parent", "48"],
    { ...dependencies, tracker: new GitHubTracker("fake-token", command) },
  );
  assert.deepEqual(requests, ["discover", "scan", "close"]);
  assert.equal(result.summary.outcome, "succeeded");
  assert.deepEqual(dependencies.pauses, []);
  const audit = (await readFile(result.logPath!, "utf8"))
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line) as { phase: string; operation: string });
  assert.ok(
    audit.some(
      (event) =>
        event.phase === "parent_completion" &&
        event.operation === "read_parent_completion",
    ),
  );
});

for (const mode of [
  "complete",
  "open in scan",
  "open in confirmation",
] as const) {
  await test(`parent completion drains paginated child states with ${mode}`, async (t) => {
    const { root } = await createProject(t, {
      ...validConfig,
      tracker: config,
      operationRetry: 0,
    });
    const dependencies = createCliDependencies(root);
    const closed = { state: "CLOSED", stateReason: "COMPLETED" };
    const first = issue(51, closed);
    const last = issue(52, mode === "complete" ? closed : {});
    const requests: string[] = [];
    dependencies.operator.pause = async (message) => {
      assert.match(message, /completed Parent Ticket has open children/u);
      return "q";
    };
    const command: GitHubCommand = async (_args, { input }) => {
      const { query, variables } = JSON.parse(input!) as {
        query: string;
        variables: { owner: string; after?: string };
      };
      if (query.includes("query ParentDiscovery")) {
        requests.push("discover");
        return JSON.stringify(
          observation(
            connection([
              child(51, closed),
              child(52, mode === "open in scan" ? {} : closed),
            ]),
          ),
        );
      }
      if (variables.after !== undefined) {
        const cursor = variables.after;
        requests.push(cursor);
        assert.equal(variables.owner, "issue-48");
        return JSON.stringify({
          data: {
            node: {
              id: variables.owner,
              subIssues: connection(
                [
                  cursor === "scan-next" && mode === "open in confirmation"
                    ? issue(52, closed)
                    : last,
                ],
                2,
              ),
            },
          },
        });
      }
      if (query.includes("closeIssue")) {
        requests.push("close");
        return JSON.stringify({
          data: {
            closeIssue: {
              issue: issue(48, {
                ...closed,
                subIssues: connection([first], 2, "confirmation-next", true),
              }),
            },
          },
        });
      }
      if (requests.includes("close")) {
        requests.push("reconcile");
        return JSON.stringify(observation(connection([first, last])));
      }
      requests.push("scan");
      return JSON.stringify(
        observation(connection([first], 2, "scan-next", true)),
      );
    };
    const result = await executeCli(
      ["run", "--project", "demo", "--parent", "48"],
      { ...dependencies, tracker: new GitHubTracker("fake-token", command) },
    );
    const expected = ["discover", "scan", "scan-next"];
    if (mode !== "open in scan") expected.push("close", "confirmation-next");
    if (mode === "open in confirmation") expected.push("reconcile");
    assert.deepEqual(requests, expected);
    assert.equal(
      result.summary.outcome,
      {
        complete: "succeeded",
        "open in scan": "incomplete",
        "open in confirmation": "cancelled",
      }[mode],
    );
    if (mode === "open in scan") {
      const audit = await readFile(result.logPath!, "utf8");
      assert.match(
        audit,
        /"operation":"read_parent_completion".*"result":"succeeded"/u,
      );
      assert.match(audit, /"operation":"close_parent".*"result":"skipped"/u);
      assert.doesNotMatch(
        audit,
        /"operation":"close_parent".*"result":"succeeded"/u,
      );
    }
  });
}

for (const invalid of [
  "missing Issue",
  "wrong Issue",
  "incomplete children",
  "GraphQL errors",
] as const) {
  await test(`parent closure reconciles ${invalid} using a fresh scope observation`, async (t) => {
    const { root } = await createProject(t, {
      ...validConfig,
      tracker: config,
    });
    const dependencies = createCliDependencies(root);
    const closed = { state: "CLOSED", stateReason: "COMPLETED" };
    const subIssues = connection([child(51, closed)]);
    const open = observation(subIssues);
    const requests: string[] = [];
    const command: GitHubCommand = async (_args, { input }) => {
      const { query } = JSON.parse(input!) as { query: string };
      if (query.includes("closeIssue")) {
        requests.push("close");
        const parent = issue(48, {
          ...closed,
          id: invalid === "wrong Issue" ? "incorrect-id" : "issue-48",
          subIssues:
            invalid === "incomplete children" ? connection([], 1) : subIssues,
        });
        const result = {
          data: {
            closeIssue: { issue: invalid === "missing Issue" ? null : parent },
          },
        };
        if (invalid === "GraphQL errors")
          return {
            stdout: JSON.stringify({
              ...result,
              errors: [
                {
                  message: "child states denied",
                  path: ["closeIssue", "issue", "subIssues"],
                },
              ],
            }),
            error: new Error("gh failed"),
            exitCode: 1,
          };
        return JSON.stringify(result);
      }
      if (query.includes("query ParentDiscovery")) {
        requests.push("discover");
        return JSON.stringify(open);
      }
      if (!requests.includes("close")) {
        requests.push("scan");
        return JSON.stringify(open);
      }
      requests.push("reconcile");
      return JSON.stringify({
        data: {
          repository: {
            ...open.data.repository,
            issue: issue(48, { ...closed, subIssues }),
          },
        },
      });
    };
    const result = await executeCli(
      ["run", "--project", "demo", "--parent", "48"],
      { ...dependencies, tracker: new GitHubTracker("fake-token", command) },
    );
    assert.deepEqual(requests, ["discover", "scan", "close", "reconcile"]);
    assert.equal(result.summary.outcome, "succeeded");
    assert.deepEqual(dependencies.pauses, []);
  });
}

for (const {
  name,
  subIssues,
  parentFields,
  label,
  outcome,
  error,
  cancel,
  missingUser,
} of [
  {
    name: "a readable foreign child fails the Run without pause or retry",
    subIssues: connection([
      child(48, {
        id: "foreign-issue",
        repository: { id: "foreign-repo", nameWithOwner: "outside/repo" },
      }),
    ]),
    outcome: "failed",
    error: /cross-repository child outside\/repo#48/u,
  },
  {
    name: "an empty parent has no work when the Reservation label is absent",
    subIssues: connection([]),
    label: null,
    outcome: "no_work",
  },
  {
    name: "a completed parent needs no Reservation label",
    subIssues: connection([
      child(51, { state: "CLOSED", stateReason: "COMPLETED" }),
    ]),
    parentFields: { state: "CLOSED", stateReason: "COMPLETED" },
    label: null,
    outcome: "succeeded",
  },
  {
    name: "an all-ineligible parent has no Batch when the Reservation label is absent",
    subIssues: connection([
      child(51, {
        labels: connection([{ id: "ready-id", name: "ready-for-agent" }]),
        assignees: connection([{ id: "external-id", login: "developer" }]),
      }),
    ]),
    label: null,
    outcome: "incomplete",
  },
  {
    name: "an empty parent needs no Runner ID when gh reports a missing user",
    subIssues: connection([]),
    missingUser: true,
    outcome: "no_work",
  },
  {
    name: "cancellation during the first discovery request prevents every continuation",
    subIssues: connection([child(51)], 2, "child-next", true),
    outcome: "cancelled",
    cancel: true,
  },
]) {
  await test(name, async (t) => {
    const { root } = await createProject(t, {
      ...validConfig,
      tracker: config,
    });
    const dependencies = createCliDependencies(root);
    const controller = new AbortController();
    let requests = 0;
    const command: GitHubCommand = async (args) => {
      requests++;
      assert.equal(args[1], "graphql");
      if (cancel) controller.abort();
      const result = observation(subIssues);
      const data = {
        ...result.data,
        repository: {
          ...result.data.repository,
          label: label === undefined ? reservation : label,
          issue: { ...result.data.repository.issue, ...parentFields },
        },
      };
      return missingUser
        ? {
            stdout: JSON.stringify({
              data: { ...data, user: null },
              errors: [runnerNotFound],
            }),
            error: new Error(
              "gh: Could not resolve to a User with the login of 'runner'.",
            ),
            exitCode: 1,
          }
        : JSON.stringify({ data });
    };
    const result = await executeCli(
      ["run", "--project", "demo", "--parent", "48"],
      {
        ...dependencies,
        signal: controller.signal,
        tracker: new GitHubTracker("fake-token", command),
      },
    );
    assert.equal(
      result.summary.outcome,
      outcome,
      JSON.stringify(result.summary),
    );
    if (error) assert.match(result.summary.failure!, error);
    assert.equal(requests, outcome === "incomplete" ? 2 : 1);
    assert.deepEqual(dependencies.pauses, []);
    assert.deepEqual(dependencies.effects, []);
  });
}

for (const operationRetry of [1, 0]) {
  await test(`eligible work rereads a missing Reservation label after creation fails and ${operationRetry ? "backoff" : "Operator Pause"}`, async (t) => {
    const fixture = await parentDeliveryRun(t, [workflowChild(51)], {
      ...validConfig,
      tracker: config,
      operationRetry,
    });
    const pauses: string[] = [];
    fixture.dependencies.operator.pause = async (message) => {
      pauses.push(message);
      assert.match(message, /Create label denied/u);
      assert.deepEqual(fixture.writes, []);
      return "";
    };
    const reads: string[] = [];
    const command: GitHubCommand = async () => {
      const state = fixture.children[0]!.state;
      reads.push(state);
      if (reads.length <= 2) assert.deepEqual(fixture.writes, []);
      const fields =
        state === "closed"
          ? { state: "CLOSED", stateReason: "COMPLETED" }
          : {
              labels: connection([{ id: "ready-id", name: "ready-for-agent" }]),
            };
      const { data } = observation(connection([child(51, fields)]));
      if (reads.length === 1)
        return JSON.stringify({
          data: { ...data, repository: { ...data.repository, label: null } },
        });
      return JSON.stringify({ data });
    };
    const tracker = new GitHubTracker("fake-token", command);
    fixture.dependencies.tracker.discoverParent =
      tracker.discoverParent.bind(tracker);
    let createRequests = 0;
    fixture.dependencies.tracker.createLabel = async () => {
      createRequests += 1;
      throw new Error("Create label denied");
    };
    const result = await fixture.run();
    assert.equal(
      result.summary.outcome,
      "succeeded",
      JSON.stringify(result.summary),
    );
    assert.deepEqual(fixture.dispatched, [51]);
    assert.deepEqual(reads, ["open", "open"]);
    assert.equal(createRequests, 1);
    assert.equal(pauses.length, operationRetry ? 0 : 1);
  });
}
