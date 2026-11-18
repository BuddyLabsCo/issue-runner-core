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
      const get = host.getPullRequest.bind(host);
      const fetch = fixture.dependencies.gitWorkspace.fetchTargetBranch.bind(
        fixture.dependencies.gitWorkspace,
      );
      const events: string[] = [];
      let waitingTicket: number | undefined;
      const externalMerge = scenario === "merged" || scenario === "retargeted";
      host.observePullRequest = async (input) => {
        const observation = await observe(input);
        if (input.number !== 83) return observation;
        if (waitingTicket !== undefined) events.push("observe recorded PR");
        if (externalMerge) {
          if (waitingTicket === undefined)
            observation.merge.mergeable = "conflicting";
          else {
            observation.pullRequest.state = "merged";
            observation.merge.merged = true;
            observation.branch.headSha = null;
            if (scenario === "retargeted")
              observation.pullRequest.targetBranch = "other-base";
          }
        }
        if (scenario === "queued" && !observation.merge.merged) {
          observation.merge.isInMergeQueue = true;
          observation.merge.mergeRequested = true;
          if (waitingTicket !== undefined) fixture.merged.add(input.number);
        }
        return observation;
      };
      host.getPullRequest = async (repository, number) => {
        if (number === 83 && waitingTicket !== undefined)
          events.push("read PR state");
        return get(repository, number);
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
          if (scenario === "queued")
            assert.equal(saved.publication?.checksState?.isInMergeQueue, true);
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
      assert.ok(events.includes("observe recorded PR"));
      if (scenario === "healthy")
        assert.deepEqual(events.slice(0, events.indexOf("request merge") + 1), [
          "observe recorded PR",
          "request merge",
        ]);
    },
  );
}
