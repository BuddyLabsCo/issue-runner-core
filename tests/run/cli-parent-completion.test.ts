/* eslint-disable @typescript-eslint/require-await -- Scripted external boundaries. */
import assert from "node:assert/strict";
import test from "node:test";
import { child, parentDeliveryRun, parentRun } from "../support/parent-run.ts";
import { implementationProgress } from "../support/implementation-run.ts";
import { validConfig } from "../support/cli-project.ts";
import type { CodeHost } from "../../src/run/contracts.ts";

await test("an all-cancelled parent closes only after completed tracker state is observed", async (t) => {
  const fixture = await parentRun(t, [
    child(51, { state: "closed", stateReason: "not_planned" }),
  ]);
  let closed = false;
  let closures = 0;
  fixture.dependencies.tracker.getParent = async () => ({
    number: 48,
    state: closed ? "closed" : "open",
    stateReason: closed ? "completed" : null,
  });
  fixture.dependencies.tracker.closeTicket = async (_repository, number) => {
    assert.equal(number, 48);
    closures++;
    closed = true;
  };
  const result = await fixture.run();
  assert.equal(result.summary.outcome, "succeeded", JSON.stringify(result));
  assert.equal(closures, 1);
  assert.deepEqual(fixture.dispatched, []);
  assert.deepEqual(fixture.writes, []);
});

await test("each successive bounded Batch fetches the current Target Branch", async (t) => {
  const fixture = await parentDeliveryRun(
    t,
    [child(53), child(51), child(52)],
    {
      ...validConfig,
      maxBatchSize: 1,
    },
  );
  const bases = ["a".repeat(40), "b".repeat(40), "c".repeat(40)];
  let fetches = 0;
  fixture.dependencies.gitWorkspace.fetchTargetBranch = async () =>
    bases[fetches++]!;
  assert.equal((await fixture.run()).summary.outcome, "succeeded");
  assert.deepEqual(fixture.dispatched, [51, 52, 53]);
  assert.equal(fetches, 3);
  for (const [index, number] of [51, 52, 53].entries())
    assert.equal(
      (await implementationProgress(fixture.directory, number)).base,
      bases[index],
    );
});

for (const extra of [
  { labels: [] },
  { assignees: ["developer"] },
  { labels: ["ready-for-agent", "sandcastle:reserved"] },
]) {
  await test(`unresolved child ${JSON.stringify(extra)} prevents closure after a successful Batch`, async (t) => {
    const fixture = await parentDeliveryRun(t, [
      child(51),
      child(52, structuredClone(extra)),
    ]);
    assert.equal((await fixture.run()).summary.outcome, "incomplete");
    assert.deepEqual(fixture.dispatched, [51]);
    assert.deepEqual(fixture.closures, [51]);
    assert.equal(
      (await implementationProgress(fixture.directory, 51)).publication?.phase,
      "delivered",
    );
    assert.equal(fixture.parent.state, "open");
  });
}

await test("an unresolved child outside issueList prevents parent closure", async (t) => {
  const fixture = await parentDeliveryRun(t, [child(51), child(52)], {
    ...validConfig,
    issueList: [51],
  });
  assert.equal((await fixture.run()).summary.outcome, "incomplete");
  assert.deepEqual(fixture.dispatched, [51]);
  assert.deepEqual(fixture.closures, [51]);
});

await test("a new child in the final closure scan keeps the parent open", async (t) => {
  const children = [child(51, { state: "closed", stateReason: "completed" })];
  const fixture = await parentDeliveryRun(t, children);
  let scans = 0;
  fixture.dependencies.tracker.listChildrenPage = async () => {
    if (++scans === 2) children.push(child(52, { labels: [] }));
    return { children: structuredClone(children), nextPage: null };
  };
  assert.equal((await fixture.run()).summary.outcome, "incomplete");
  assert.deepEqual(fixture.closures, []);
  assert.deepEqual(fixture.dispatched, []);
});

await test("a lost parent closure response reconciles without repeating the write or child work", async (t) => {
  const fixture = await parentDeliveryRun(t, [child(51)]);
  const close = fixture.dependencies.tracker.closeTicket.bind(
    fixture.dependencies.tracker,
  );
  fixture.dependencies.tracker.closeTicket = async (...args) => {
    await close(...args);
    if (args[1] === 48) throw new Error("response lost after closing parent");
  };
  assert.equal((await fixture.run()).summary.outcome, "succeeded");
  assert.deepEqual(fixture.dispatched, [51]);
  assert.deepEqual(fixture.closures, [51, 48]);
  assert.equal(
    (await implementationProgress(fixture.directory, 51)).publication?.phase,
    "delivered",
  );
});

await test("an unconfirmed parent closure pauses and a matching rerun retains completed child evidence", async (t) => {
  const fixture = await parentDeliveryRun(t, [child(51)]);
  const close = fixture.dependencies.tracker.closeTicket.bind(
    fixture.dependencies.tracker,
  );
  let attempts = 0;
  fixture.dependencies.tracker.closeTicket = async (...args) => {
    if (args[1] !== 48) return close(...args);
    attempts++;
  };
  fixture.dependencies.operator.pause = async (message) => {
    assert.match(message, /Parent closure has not been confirmed/u);
    assert.doesNotMatch(message, /s to skip/u);
    return "q";
  };
  assert.equal((await fixture.run()).summary.outcome, "cancelled");
  assert.equal(attempts, 2);
  const before = await implementationProgress(fixture.directory, 51);
  assert.equal(before.publication?.phase, "delivered");
  fixture.dependencies.tracker.closeTicket = close;
  assert.equal((await fixture.run()).summary.outcome, "succeeded");
  assert.deepEqual(fixture.dispatched, [51]);
  assert.deepEqual(fixture.closures, [51, 48]);
  assert.deepEqual(await implementationProgress(fixture.directory, 51), before);
});

await test("matching recovery continues a partially integrated Batch without replaying delivered children", async (t) => {
  const fixture = await parentDeliveryRun(
    t,
    [child(51), child(52), child(53)],
    {
      ...validConfig,
      maxBatchSize: 2,
    },
  );
  let rejectSecond = true;
  const requests: number[] = [];
  Object.assign(fixture.dependencies.codeHost, {
    async requestSquashMerge(
      input: Parameters<CodeHost["requestSquashMerge"]>[0],
    ) {
      requests.push(input.pullRequest);
      if (rejectSecond && requests.length > 1)
        return {
          outcome: "rejected",
          error: new Error("second merge rejected"),
        };
      fixture.merged.add(input.pullRequest);
      return { outcome: "accepted" };
    },
  });
  fixture.dependencies.operator.pause = async (message) => {
    assert.match(message, /second merge rejected/u);
    return "q";
  };
  assert.equal((await fixture.run()).summary.outcome, "cancelled");
  const delivered = fixture.children.find(
    (ticket) => ticket.state === "closed",
  )!;
  const before = await implementationProgress(
    fixture.directory,
    delivered.number,
  );
  assert.equal(before.publication?.phase, "delivered");
  const merged = [...fixture.merged];
  assert.equal(merged.length, 1);
  rejectSecond = false;
  requests.length = 0;
  assert.equal((await fixture.run()).summary.outcome, "succeeded");
  assert.deepEqual([...fixture.dispatched].sort(), [51, 52, 53]);
  assert.ok(!requests.includes(merged[0]!));
  assert.deepEqual(
    await implementationProgress(fixture.directory, delivered.number),
    before,
  );
  assert.deepEqual([...fixture.closures].sort(), [48, 51, 52, 53]);
});

await test("parent cancellation during closure backoff stops retries without changing its children", async (t) => {
  const children = [child(51, { state: "closed", stateReason: "not_planned" })];
  const fixture = await parentDeliveryRun(t, children);
  const before = structuredClone(children);
  let attempts = 0;
  fixture.dependencies.tracker.closeTicket = async () => {
    attempts++;
    throw new Error("closure request failed");
  };
  fixture.dependencies.clock.sleep = async (ms) => {
    assert.equal(ms, 1000);
    fixture.parent.state = "closed";
    fixture.parent.stateReason = "not_planned";
  };
  assert.equal((await fixture.run()).summary.outcome, "cancelled");
  assert.equal(attempts, 1);
  assert.deepEqual(children, before);
  assert.deepEqual(fixture.dispatched, []);
});

await test("a delivered child reopened during parent closure stays incomplete without replaying its completed work", async (t) => {
  const fixture = await parentDeliveryRun(t, [child(51)]);
  const close = fixture.dependencies.tracker.closeTicket.bind(
    fixture.dependencies.tracker,
  );
  fixture.dependencies.tracker.closeTicket = async (...args) => {
    if (args[1] !== 48) return close(...args);
    throw new Error("parent closure failed before writing");
  };
  fixture.dependencies.clock.sleep = async (ms) => {
    if (ms !== 1000) return;
    fixture.children[0]!.state = "open";
    fixture.children[0]!.stateReason = null;
  };
  const timeout = setTimeout(() => fixture.controller.abort(), 2000);
  try {
    const result = await fixture.run();
    assert.equal(result.summary.outcome, "incomplete", JSON.stringify(result));
    assert.deepEqual(fixture.dispatched, [51]);
    assert.deepEqual(fixture.closures, [51]);
    assert.equal(
      (await implementationProgress(fixture.directory, 51)).publication?.phase,
      "delivered",
    );
    assert.equal(fixture.children[0]!.state, "open");
  } finally {
    clearTimeout(timeout);
  }
});

for (const reason of ["completed", "not_planned"] as const) {
  await test(`parent ${reason} after a Batch stops further dispatch without rewriting children`, async (t) => {
    const fixture = await parentDeliveryRun(t, [child(51), child(52)], {
      ...validConfig,
      maxBatchSize: 1,
    });
    const close = fixture.dependencies.tracker.closeTicket.bind(
      fixture.dependencies.tracker,
    );
    fixture.dependencies.tracker.closeTicket = async (...args) => {
      await close(...args);
      fixture.parent.state = "closed";
      fixture.parent.stateReason = reason;
    };
    // The child completion boundary still needs to observe the active parent.
    // Change it only once the first Batch's delivery evidence is durable.
    let terminal = false;
    fixture.dependencies.tracker.getParent = async () => {
      if (!terminal && fixture.parent.state === "closed") {
        try {
          terminal =
            (await implementationProgress(fixture.directory, 51)).publication
              ?.phase === "delivered";
        } catch {
          terminal = false;
        }
      }
      return terminal ? structuredClone(fixture.parent) : child(48);
    };
    const result = await fixture.run();
    assert.equal(
      result.summary.outcome,
      reason === "not_planned" ? "cancelled" : "failed",
    );
    if (reason === "completed")
      assert.match(
        result.summary.reasons.join(" "),
        /completed Parent Ticket has open children/u,
      );
    assert.deepEqual(fixture.dispatched, [51]);
    assert.deepEqual(fixture.closures, [51]);
    assert.equal(fixture.children[1]!.state, "open");
    assert.equal(
      (await implementationProgress(fixture.directory, 51)).publication?.phase,
      "delivered",
    );
  });
}

await test("parent rescans after a Batch and delivers a newly unblocked child before closure", async (t) => {
  const children = [child(51), child(52)];
  const fixture = await parentDeliveryRun(t, children);
  fixture.dependencies.tracker.listBlockersPage = async (
    _repository,
    number,
  ) => ({
    blockers: number === 52 ? [structuredClone(children[0]!)] : [],
    nextPage: null,
  });
  const result = await fixture.run();
  assert.equal(result.summary.outcome, "succeeded", JSON.stringify(result));
  assert.deepEqual(fixture.dispatched, [51, 52]);
  assert.deepEqual(fixture.closures, [51, 52, 48]);
  for (const number of [51, 52])
    assert.equal(
      (await implementationProgress(fixture.directory, number)).publication
        ?.phase,
      "delivered",
    );
});
