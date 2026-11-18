/* eslint-disable @typescript-eslint/require-await -- Scripted external boundaries. */
import assert from "node:assert/strict";
import test from "node:test";
import { batchRun } from "../support/batch-integration-run.ts";
import { implementationProgress } from "../support/implementation-run.ts";

for (const scenario of ["merged", "retargeted", "queued", "healthy"] as const) {
  await test(
    `Batch refresh handles a ${scenario} deferred PR`,
    { timeout: 10_000 },
    async (t) => {
      const fixture = await batchRun(t);
      const host = fixture.dependencies.codeHost;
      const observe = host.observePullRequest.bind(host);
      const delivery = host.observeDelivery.bind(host);
      const fetch = fixture.dependencies.gitWorkspace.fetchTargetBranch.bind(
        fixture.dependencies.gitWorkspace,
      );
      const events: string[] = [];
      let waitingTicket: number | undefined;
      const externalMerge = scenario === "merged" || scenario === "retargeted";
      host.observePullRequest = async (input) => {
        const observation = await observe(input);
        if (input.number !== 83) return observation;
        if (externalMerge) observation.merge.mergeable = "conflicting";
        if (scenario === "queued") {
          observation.merge.isInMergeQueue = true;
          observation.merge.mergeRequested = true;
        }
        return observation;
      };
      host.observeDelivery = async (input) => {
        if (input.number === 83) events.push("observe delivery");
        const observation = await delivery(input);
        if (input.number === 83 && scenario === "retargeted")
          observation.pullRequest.targetBranch = "other-base";
        return observation;
      };
      fixture.state.onMerge = async (number) => {
        fixture.merged.add(number);
        if (number === 82) {
          const waiting = (await host.listPullRequests()).find(
            (pr) => pr.number === 83,
          )!;
          waitingTicket = Number(waiting.branch.split("/ticket-").at(-1));
          const saved = await implementationProgress(
            fixture.directory,
            waitingTicket,
          );
          assert.equal(saved.publication?.phase, "checks_ready");
          if (externalMerge) {
            assert.equal(
              saved.publication?.checksState?.mergeable,
              "conflicting",
            );
            fixture.merged.add(waiting.number);
          }
          if (scenario === "queued") {
            assert.equal(saved.publication?.checksState?.isInMergeQueue, true);
            fixture.merged.add(waiting.number);
          }
        }
        if (number === 83) events.push("request merge");
        return { outcome: "accepted" };
      };
      fixture.dependencies.gitWorkspace.fetchTargetBranch = async () => {
        assert.equal(
          waitingTicket,
          undefined,
          "deferred PR must not start conflict repair",
        );
        return fetch();
      };
      fixture.dependencies.operator.pause = async (message) => {
        assert.equal(scenario, "retargeted", message);
        assert.match(message, /Pull Request identity or head mismatch/u);
        return "q";
      };
      const result = await fixture.run();
      assert.equal(
        result.summary.outcome,
        scenario === "retargeted" ? "cancelled" : "succeeded",
        JSON.stringify(result),
      );
      const waiting = fixture.children.find(
        (ticket) => ticket.number === waitingTicket,
      )!;
      if (scenario === "retargeted") {
        assert.equal(waiting.state, "open");
        assert.ok(!fixture.closures.includes(waiting.number));
        assert.deepEqual(fixture.requests, [82]);
      } else {
        assert.equal(waiting.stateReason, "completed");
        assert.ok(fixture.closures.includes(waiting.number));
        assert.deepEqual(
          fixture.requests,
          scenario === "healthy" ? [82, 83, 81] : [82, 81],
        );
      }
      assert.equal(
        events[0],
        scenario === "healthy" ? "request merge" : "observe delivery",
      );
    },
  );
}
