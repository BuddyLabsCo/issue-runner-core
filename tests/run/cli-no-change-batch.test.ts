/* eslint-disable @typescript-eslint/require-await -- Scripted external boundaries. */
import assert from "node:assert/strict";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import type { ImplementationProgress } from "../../src/recovery.ts";
import { child, parentDeliveryRun } from "../support/parent-run.ts";
import { validConfig } from "../support/cli-project.ts";
import {
  implementationProgress,
  publish,
} from "../support/implementation-run.ts";
import { promptAssignment } from "../support/prompt-assignment.ts";
import {
  batchDocumentationRun,
  documentationNoChange,
} from "../support/batch-documentation-run.ts";

for (const unfinished of [false, true]) {
  await test(`no-change completes independently with a ${unfinished ? "unfinished" : "CI-ready"} peer and permits later parent scheduling`, async (t) => {
    const tickets = [child(51), child(52), child(53)];
    const fixture = await parentDeliveryRun(t, tickets, {
      ...validConfig,
      maxBatchSize: 2,
    });
    const comments: number[] = [];
    fixture.dependencies.tracker.commentTicket = async (
      _repository,
      number,
    ) => {
      comments.push(number);
    };
    const submit = fixture.dependencies.terminalPlugin.onInput.bind(
      fixture.dependencies.terminalPlugin,
    );
    fixture.dependencies.terminalPlugin.onInput = async (tab, text, chord) => {
      if (text.startsWith("Implementation assignment\n")) {
        const assignment = promptAssignment(text);
        if (assignment.ticket === 51) {
          await publish(assignment.path, {
            ...documentationNoChange,
            summary:
              "Existing implementation satisfies the Issue; focused checks passed.",
          });
          return;
        }
        if (unfinished && assignment.ticket === 52)
          tickets[1]!.assignees = ["outside-owner"];
      }
      await submit(tab, text, chord);
    };
    const result = await fixture.run();
    assert.equal(
      result.summary.outcome,
      unfinished ? "incomplete" : "succeeded",
      JSON.stringify(result),
    );
    assert.equal(tickets[0]!.stateReason, "completed");
    assert.equal(
      result.summary.tickets?.find((ticket) => ticket.ticket === 51)?.status,
      "completed",
    );
    const noChange = await implementationProgress(fixture.directory, 51);
    assert.equal(noChange.noChange?.delivery?.phase, "delivered");
    assert.equal(noChange.cleanup?.worktrees.length, 1);
    assert.equal(noChange.publication, undefined);
    assert.deepEqual(comments, [51]);
    if (unfinished) {
      assert.equal(tickets[1]!.state, "open");
      assert.equal(tickets[2]!.state, "open");
      assert.equal(fixture.merged.size, 0);
      tickets[1]!.assignees = ["runner"];
      fixture.dependencies.signal = new AbortController().signal;
      assert.equal((await fixture.run()).summary.outcome, "succeeded");
      assert.deepEqual(comments, [51]);
    }
    assert.equal(fixture.merged.size, 2);
    assert.deepEqual(fixture.dispatched, [52, 53]);
    assert.ok(tickets.every((ticket) => ticket.stateReason === "completed"));
    assert.equal(fixture.parent.stateReason, "completed");
  });
}

await test("restart after no-change cleanup finishes delivery-label and Batch documentation bookkeeping", async (t) => {
  const ticket = child(51, { labels: ["ready-for-agent", "Docs"] });
  const fixture = await batchDocumentationRun(t, [ticket]);
  fixture.dependencies.tracker.commentTicket = async () => {
    /* Scripted successful comment. */
  };
  const submit = fixture.dependencies.terminalPlugin.onInput.bind(
    fixture.dependencies.terminalPlugin,
  );
  fixture.dependencies.terminalPlugin.onInput = async (tab, text, chord) => {
    if (text.startsWith("Implementation assignment\n")) {
      await publish(promptAssignment(text).path, documentationNoChange);
    } else await submit(tab, text, chord);
  };
  const now = fixture.dependencies.clock.now.bind(fixture.dependencies.clock);
  const recovery = path.join(fixture.directory, "recovery");
  fixture.dependencies.clock.now = () => {
    const file = existsSync(recovery)
      ? readdirSync(recovery).find((file) => file.endsWith("-51.json"))
      : undefined;
    if (file) {
      const saved = JSON.parse(
        readFileSync(path.join(recovery, file), "utf8"),
      ) as ImplementationProgress;
      if (
        saved.noChange?.delivery?.phase === "delivered" &&
        saved.cleanup?.files.includes(`${saved.invocation!.path}.tmp`)
      )
        fixture.controller.abort();
    }
    return now();
  };
  assert.equal((await fixture.run()).summary.outcome, "cancelled");
  assert.equal(fixture.maintenance.length, 0);
  const saved = await implementationProgress(fixture.directory, 51);
  assert.equal(existsSync(saved.worktree), false);
  assert.ok(saved.noChange?.delivery?.deliveryLabels?.includes("Docs"));
  ticket.labels = ["ready-for-agent"];
  fixture.dependencies.clock.now = now;
  fixture.dependencies.signal = new AbortController().signal;
  const result = await fixture.run();
  assert.equal(result.summary.outcome, "succeeded", JSON.stringify(result));
  assert.equal(fixture.maintenance.length, 1);
  assert.deepEqual(fixture.dispatched, []);
  assert.equal(fixture.merged.size, 0);
});
