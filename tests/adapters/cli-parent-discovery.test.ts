/* eslint-disable @typescript-eslint/require-await -- Scripted GitHub command. */
import assert from "node:assert/strict";
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
  observation,
  reservation,
  runnerNotFound,
} from "../support/github-parent-discovery.ts";

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
  await test(`eligible work rereads a missing Reservation label ${operationRetry ? "after backoff" : "after Operator Pause"}`, async (t) => {
    const fixture = await parentDeliveryRun(t, [workflowChild(51)], {
      ...validConfig,
      tracker: config,
      operationRetry,
    });
    const pauses: string[] = [];
    fixture.dependencies.operator.pause = async (message) => {
      pauses.push(message);
      assert.match(message, /configured Reservation label/u);
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
    const result = await fixture.run();
    assert.equal(
      result.summary.outcome,
      "succeeded",
      JSON.stringify(result.summary),
    );
    assert.deepEqual(fixture.dispatched, [51]);
    assert.deepEqual(reads, ["open", "open", "closed"]);
    assert.equal(pauses.length, operationRetry ? 0 : 1);
  });
}
