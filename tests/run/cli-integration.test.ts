/* eslint-disable @typescript-eslint/require-await -- Scripted external boundaries. */
import assert from "node:assert/strict";
import test from "node:test";
import { readdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { executeCli } from "../../src/cli.ts";
import {
  deliveryCommand as implementationCommand,
  implementationCommit,
} from "../support/implementation-run.ts";
import { publicationRun } from "../support/publication-run.ts";
import { integrationRun } from "../support/integration-run.ts";
import { validConfig } from "../support/cli-project.ts";

await test("delivery requires confirmed squash integration and completed tracker state, capturing exact labels", async (t) => {
  const fixture = await publicationRun(t);
  const effects: string[] = [];
  let merged = false;
  Object.assign(fixture.dependencies.codeHost, {
    async getPullRequest() {
      return {
        headSha: implementationCommit.sha,
        createdAt: "2026-10-30T00:00:00Z",
        merged,
        mergeRequested: false,
        mergeable: "mergeable",
        mergeFailure: null,
      };
    },
    async requestSquashMerge(input: unknown) {
      assert.deepEqual(input, {
        repository: "owner/repo",
        pullRequest: 81,
        headSha: implementationCommit.sha,
        admin: false,
      });
      assert.equal(fixture.state.ticket.state, "open");
      effects.push("merge");
      merged = true;
      return { outcome: "accepted" };
    },
  });
  Object.assign(fixture.dependencies.tracker, {
    async closeTicket() {
      assert.equal(merged, true);
      effects.push("close");
      fixture.state.ticket.state = "closed";
      fixture.state.ticket.stateReason = "completed";
      fixture.state.ticket.labels = ["Docs", "docs", "ready-for-agent"];
    },
  });
  const result = await executeCli(implementationCommand, fixture.dependencies);
  assert.equal(result.summary.outcome, "succeeded", JSON.stringify(result));
  assert.equal(result.exitCode, 0);
  assert.equal(result.summary.tickets?.[0]?.status, "completed");
  assert.deepEqual(effects, ["merge", "close"]);
  const saved = await fixture.snapshot();
  assert.equal(saved.publication?.phase, "delivered");
  assert.deepEqual(
    (saved.publication as unknown as Record<string, unknown>).deliveryLabels,
    ["Docs", "docs", "ready-for-agent"],
  );
});

await test("queue admission receives no delivery credit before the configured merge confirmation timeout", async (t) => {
  const fixture = await integrationRun(t, {
    ...validConfig,
    timeouts: { ...validConfig.timeouts, mergeQueueMinutes: 0.25 },
  });
  fixture.integrationState.onMerge = async () => {
    fixture.integrationState.pullRequest.mergeRequested = true;
    return { outcome: "accepted" };
  };
  fixture.dependencies.operator.pause = async (message) => {
    assert.match(message, /Merge confirmation timed out/u);
    assert.equal(fixture.integrationState.closures, 0);
    return "q";
  };
  assert.equal((await fixture.run()).summary.outcome, "cancelled");
  assert.equal(fixture.integrationState.requests.length, 1);
  assert.deepEqual(fixture.state.sleeps, [10_000, 30_000, 10_000, 5_000]);
  assert.equal(
    (await fixture.snapshot()).publication?.phase,
    "merge_requested",
  );
});

await test("a queued squash is observed as merged before runner closure, including admin policy", async (t) => {
  const fixture = await integrationRun(t, {
    ...validConfig,
    codeHost: { ...validConfig.codeHost, adminMerge: true },
  });
  fixture.integrationState.onMerge = async () => {
    fixture.integrationState.pullRequest.mergeRequested = true;
    return { outcome: "accepted" };
  };
  fixture.state.onSleep = async () => {
    if (fixture.integrationState.pullRequest.mergeRequested) {
      assert.equal(fixture.integrationState.closures, 0);
      fixture.integrationState.pullRequest.merged = true;
    }
  };
  assert.equal((await fixture.run()).summary.outcome, "succeeded");
  assert.equal(fixture.integrationState.requests[0]!.admin, true);
  assert.equal(fixture.integrationState.closures, 1);
  assert.equal((await fixture.snapshot()).publication?.merge?.merged, true);
});

for (const changed of ["not_planned", "reservation"] as const) {
  await test(`${changed} after merge earns no delivery credit`, async (t) => {
    const fixture = await integrationRun(t);
    fixture.integrationState.onMerge = async () => {
      fixture.integrationState.pullRequest.merged = true;
      if (changed === "not_planned") {
        fixture.state.ticket.state = "closed";
        fixture.state.ticket.stateReason = "not_planned";
      } else {
        fixture.state.ticket.labels = ["ready-for-agent"];
        fixture.state.ticket.assignees = [];
      }
      return { outcome: "accepted" };
    };
    assert.equal((await fixture.run()).summary.outcome, "incomplete");
    assert.equal(fixture.integrationState.closures, 0);
    assert.equal((await fixture.snapshot()).publication?.phase, "merged");
    assert.equal(
      (await fixture.snapshot()).publication?.deliveryLabels,
      undefined,
    );
  });
}

for (const lost of ["merge", "closure"] as const) {
  await test(`a lost ${lost} response reconciles observed completion without replaying the write`, async (t) => {
    const fixture = await integrationRun(t);
    if (lost === "merge")
      fixture.integrationState.onMerge = async () => {
        fixture.integrationState.pullRequest.merged = true;
        throw new Error("merge response lost");
      };
    else
      fixture.integrationState.onClose = async () => {
        fixture.state.ticket.state = "closed";
        fixture.state.ticket.stateReason = "completed";
        throw new Error("closure response lost");
      };
    assert.equal((await fixture.run()).summary.outcome, "succeeded");
    assert.equal(fixture.integrationState.requests.length, 1);
    assert.equal(fixture.integrationState.closures, 1);
    assert.equal(fixture.dependencies.pauses.length, 0);
  });
}

await test("an acknowledged tracker write still needs observed closed/completed state", async (t) => {
  const fixture = await integrationRun(t);
  fixture.integrationState.onClose = async () => {
    /* Remains open. */
  };
  fixture.dependencies.operator.pause = async (message) => {
    assert.match(message, /closure has not been confirmed/u);
    return "q";
  };
  assert.equal((await fixture.run()).summary.outcome, "cancelled");
  assert.equal((await fixture.snapshot()).publication?.phase, "merged");
  assert.equal((await fixture.snapshot()).publication?.closure, undefined);
});

await test("non-conflict rejection retains the original error and cannot trigger delivery", async (t) => {
  const fixture = await integrationRun(t);
  const cause = new Error("branch protection forbids this merge");
  fixture.integrationState.onMerge = async () => ({
    outcome: "rejected",
    error: cause,
  });
  fixture.dependencies.operator.pause = async (message) => {
    assert.match(message, /branch protection forbids this merge/u);
    return "q";
  };
  assert.equal((await fixture.run()).summary.outcome, "cancelled");
  assert.equal(fixture.integrationState.requests.length, 2);
  assert.equal(fixture.integrationState.closures, 0);
});

await test("recovery after a confirmed merge skips Agent and merge work and finishes tracker confirmation", async (t) => {
  const fixture = await integrationRun(t);
  fixture.integrationState.onClose = async () => {
    fixture.state.ticket.state = "closed";
    fixture.state.ticket.stateReason = "completed";
    fixture.controller.abort();
  };
  assert.equal((await fixture.run()).summary.outcome, "cancelled");
  assert.equal((await fixture.snapshot()).publication?.phase, "merged");
  fixture.dependencies.signal = new AbortController().signal;
  assert.equal((await fixture.run()).summary.outcome, "succeeded");
  assert.equal(fixture.state.taskCount, 1);
  assert.equal(fixture.integrationState.requests.length, 1);
  assert.equal(fixture.integrationState.closures, 1);
  const labels = (await fixture.snapshot()).publication!.deliveryLabels;
  fixture.state.ticket.labels = ["changed-after-delivery"];
  assert.equal((await fixture.run()).summary.outcome, "succeeded");
  assert.deepEqual(
    (await fixture.snapshot()).publication!.deliveryLabels,
    labels,
  );
});

await test("recovery cannot credit delivery when recorded publication differs from verified commits", async (t) => {
  const fixture = await integrationRun(t);
  assert.equal((await fixture.run()).summary.outcome, "succeeded");
  const saved = await fixture.snapshot();
  saved.publication!.headSha = "c".repeat(40);
  saved.publication!.merge!.headSha = "c".repeat(40);
  const directory = path.join(fixture.directory, "recovery");
  const file = (await readdir(directory)).find((file) =>
    file.endsWith("-50.json"),
  )!;
  await writeFile(path.join(directory, file), JSON.stringify(saved));
  const result = await fixture.run();
  assert.equal(result.summary.outcome, "failed");
  assert.match(
    result.summary.reasons.join(" "),
    /Publication evidence does not match/u,
  );
});

await test("a changed observed HEAD pauses without merging or closing the Issue", async (t) => {
  const fixture = await integrationRun(t);
  fixture.integrationState.onObserve = async () => {
    if (fixture.integrationState.observations > 1)
      fixture.integrationState.pullRequest.headSha = "d".repeat(40);
  };
  fixture.dependencies.operator.pause = async (message) => {
    assert.match(message, /head changed/u);
    return "q";
  };
  assert.equal((await fixture.run()).summary.outcome, "cancelled");
  assert.equal(fixture.integrationState.requests.length, 0);
  assert.equal(fixture.integrationState.closures, 0);
});

await test("code_host closure that remains open pauses and observes again without issuing tracker writes", async (t) => {
  const fixture = await integrationRun(t, {
    ...validConfig,
    ticketClosure: "code_host",
  });
  let pauses = 0;
  fixture.dependencies.operator.pause = async (message) => {
    assert.match(message, /not closed as completed/u);
    pauses++;
    fixture.state.ticket.state = "closed";
    fixture.state.ticket.stateReason = "completed";
    return "";
  };
  assert.equal((await fixture.run()).summary.outcome, "succeeded");
  assert.equal(pauses, 1);
  assert.equal(fixture.integrationState.closures, 0);
  assert.deepEqual(
    fixture.state.sleeps,
    [10_000, 30_000, 10_000, 30_000, 10_000],
  );
});

await test("an interrupted queue resumes its existing request and deadline without another Agent or merge request", async (t) => {
  const fixture = await integrationRun(t);
  fixture.integrationState.onMerge = async () => {
    fixture.integrationState.pullRequest.mergeRequested = true;
    throw new Error("queue response lost");
  };
  fixture.state.onSleep = async () => {
    if (fixture.integrationState.pullRequest.mergeRequested)
      fixture.controller.abort();
  };
  assert.equal((await fixture.run()).summary.outcome, "cancelled");
  assert.equal(fixture.integrationState.closures, 0);
  assert.equal(
    (await fixture.snapshot()).publication?.phase,
    "merge_requested",
  );
  const deadline = (await fixture.snapshot()).publication!.mergeDeadline;
  fixture.dependencies.signal = new AbortController().signal;
  fixture.state.onSleep = async () => {
    fixture.integrationState.pullRequest.merged = true;
  };
  assert.equal((await fixture.run()).summary.outcome, "succeeded");
  assert.equal((await fixture.snapshot()).publication!.mergeDeadline, deadline);
  assert.equal(fixture.integrationState.requests.length, 1);
  assert.equal(fixture.state.taskCount, 1);
});
