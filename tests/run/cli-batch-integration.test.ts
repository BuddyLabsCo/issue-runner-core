/* eslint-disable @typescript-eslint/require-await -- Scripted external boundaries. */
import { promptAssignment } from "../support/prompt-assignment.ts";
import assert from "node:assert/strict";
import fs from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import test, { type TestContext } from "node:test";
import { setTimeout } from "node:timers/promises";
import type { ImplementationProgress } from "../../src/recovery.ts";
import type {
  CodeHost,
  MergeRequestResult,
  RequiredCheck,
} from "../../src/run/contracts.ts";
import { child, parentDeliveryRun } from "../support/parent-run.ts";
import { validConfig } from "../support/cli-project.ts";
import {
  deferred,
  implementationProgress,
  publish,
} from "../support/implementation-run.ts";

async function batchRun(t: TestContext) {
  const children = [child(51), child(52), child(53)];
  const fixture = await parentDeliveryRun(t, children, {
    ...validConfig,
    issueList: [51, 52, 53],
  });
  const ready = new Set<number>();
  const merged = new Set<number>();
  const requests: number[] = [];
  const state = {
    onChecks: async (number: number): Promise<RequiredCheck[]> => {
      assert.ok(number >= 81);
      return [];
    },
    onMerge: async (number: number): Promise<MergeRequestResult> => {
      merged.add(number);
      return { outcome: "accepted" };
    },
  };
  Object.assign(fixture.dependencies.codeHost, {
    async getRequiredChecks(_repository: string, number: number) {
      const checks = await state.onChecks(number);
      if (
        !checks.some(
          (check) => check.bucket === "fail" || check.bucket === "pending",
        )
      )
        ready.add(number);
      return checks;
    },
    async getPullRequest(_repository: string, number: number) {
      const pr = (await fixture.dependencies.codeHost.listPullRequests()).find(
        (pr) => pr.number === number,
      )!;
      return {
        headSha: pr.headSha,
        createdAt:
          number === 81 ? "2026-10-31T00:00:00Z" : "2026-10-30T00:00:00Z",
        merged: merged.has(number),
        mergeRequested: false,
        mergeable: "mergeable",
        mergeFailure: null,
      };
    },
    async requestSquashMerge(
      input: Parameters<CodeHost["requestSquashMerge"]>[0],
    ) {
      assert.equal(
        ready.size,
        3,
        "all Batch PRs must be CI-ready before the first merge",
      );
      requests.push(input.pullRequest);
      return state.onMerge(input.pullRequest);
    },
  });
  return { ...fixture, children, ready, merged, requests, state };
}

for (const [selector, checkpointDelay] of [
  ["parent", 0],
  ["issue", 0],
  ["parent", 3200],
  ["issue", 3200],
] as const) {
  await test(
    `${selector} holds the CI barrier across out-of-order implementation completion and confirms each merge before starting the next (checkpoint delay ${checkpointDelay} ms)`,
    { timeout: 10_000 },
    async (t) => {
      const fixture = await batchRun(t);
      const checkpointReady = deferred<void>();
      let checkpointObserved = false;
      const rename = fs.promises.rename;
      const checkpointRename = t.mock.method(
        fs.promises,
        "rename",
        async (...args: Parameters<typeof rename>) => {
          if (!checkpointObserved && String(args[1]).endsWith("-52.json")) {
            const progress = JSON.parse(
              await fs.promises.readFile(args[0], "utf8"),
            ) as ImplementationProgress;
            if (progress.publication?.phase === "checks_ready") {
              checkpointObserved = true;
              await setTimeout(checkpointDelay);
              await rename(...args);
              checkpointReady.resolve();
              return;
            }
          }
          await rename(...args);
        },
      );
      syncBuiltinESMExports();
      t.after(() => {
        checkpointRename.mock.restore();
        syncBuiltinESMExports();
      });
      const tasks = new Map(
        [51, 52, 53].map((number) => [number, deferred<void>()]),
      );
      const assigned = new Map(
        [51, 52, 53].map((number) => [number, deferred<void>()]),
      );
      const checks = new Map(
        [81, 82, 83].map((number) => [number, deferred<void>()]),
      );
      const observed = new Map(
        [81, 82, 83].map((number) => [number, deferred<void>()]),
      );
      const queued = deferred<void>();
      const confirmMerge = deferred<void>();
      const tabs = new Map<object, number>();
      const create = fixture.dependencies.terminalPlugin.createTab.bind(
        fixture.dependencies.terminalPlugin,
      );
      const submit = fixture.dependencies.terminalPlugin.submitText.bind(
        fixture.dependencies.terminalPlugin,
      );
      fixture.dependencies.terminalPlugin.createTab = async (options) => {
        const tab = await create(options);
        tabs.set(tab, Number(/ticket-(\d+)$/u.exec(options.cwd)![1]));
        return tab;
      };
      fixture.dependencies.terminalPlugin.submitText = async (tab, text) => {
        if (text.startsWith("Implementation assignment\n")) {
          const number = tabs.get(tab)!;
          assigned.get(number)!.resolve();
          await tasks.get(number)!.promise;
        }
        await submit(tab, text);
      };
      fixture.state.onChecks = async (number) => {
        observed.get(number)!.resolve();
        await checks.get(number)!.promise;
        return [];
      };
      let targetHead = "a".repeat(40);
      let fetches = 0;
      let pushes = 0;
      fixture.dependencies.gitWorkspace.fetchTargetBranch = async () => {
        fetches += 1;
        return targetHead;
      };
      const push = fixture.dependencies.gitWorkspace.push.bind(
        fixture.dependencies.gitWorkspace,
      );
      fixture.dependencies.gitWorkspace.push = async (...args) => {
        pushes += 1;
        await push(...args);
      };
      fixture.state.onMerge = async (number) => {
        if (number !== 82) {
          assert.equal(
            (await implementationProgress(fixture.directory, 51)).publication
              ?.phase,
            "delivered",
            "the first PR must be merged and closed before later integration",
          );
          fixture.merged.add(number);
        }
        return { outcome: "accepted" };
      };
      const getPullRequest = fixture.dependencies.codeHost.getPullRequest.bind(
        fixture.dependencies.codeHost,
      );
      fixture.dependencies.codeHost.getPullRequest = async (
        repository,
        number,
      ) => {
        if (number === 82 && fixture.requests.includes(82)) {
          queued.resolve();
          await confirmMerge.promise;
          fixture.merged.add(82);
          targetHead = "c".repeat(40);
        }
        return getPullRequest(repository, number);
      };
      const running = fixture.run([
        `--${selector}`,
        ...(selector === "parent" ? ["48"] : []),
      ]);
      try {
        await Promise.race([
          Promise.all([...assigned.values()].map(({ promise }) => promise)),
          running,
        ]);
        tasks.get(53)!.resolve();
        await Promise.race([observed.get(81)!.promise, running]);
        assert.deepEqual(fixture.requests, []);
        checks.get(81)!.resolve();
        tasks.get(51)!.resolve();
        await Promise.race([observed.get(82)!.promise, running]);
        assert.deepEqual(fixture.requests, []);
        tasks.get(52)!.resolve();
        await Promise.race([observed.get(83)!.promise, running]);
        assert.deepEqual(fixture.dispatched, [53, 51, 52]);
        assert.deepEqual([...fixture.ready], [81]);
        assert.deepEqual(fixture.requests, []);
        checks.get(83)!.resolve();
        await Promise.race([checkpointReady.promise, running]);
        assert.equal(
          (await implementationProgress(fixture.directory, 52)).publication
            ?.phase,
          "checks_ready",
        );
        assert.deepEqual([...fixture.ready], [81, 83]);
        assert.deepEqual(fixture.requests, []);
        checks.get(82)!.resolve();
        await Promise.race([queued.promise, running]);
        assert.deepEqual(fixture.requests, [82]);
        assert.equal(fixture.merged.size, 0);
        assert.equal(
          (await implementationProgress(fixture.directory, 51)).publication
            ?.phase,
          "merge_requested",
        );
        assert.ok(fixture.children.every((ticket) => ticket.state === "open"));
        confirmMerge.resolve();
        const result = await running;
        assert.equal(
          result.summary.outcome,
          "succeeded",
          JSON.stringify(result),
        );
        assert.deepEqual(fixture.requests, [82, 83, 81]);
        assert.equal(
          fetches,
          1,
          "target advancement must not refresh all branches",
        );
        assert.equal(
          pushes,
          3,
          "only initial verified branches should be pushed",
        );
        for (const number of [51, 52, 53]) {
          const progress = await implementationProgress(
            fixture.directory,
            number,
          );
          assert.equal(progress.base, "a".repeat(40));
          assert.equal(progress.publication?.phase, "delivered");
        }
      } finally {
        fixture.controller.abort();
        for (const gate of [
          ...tasks.values(),
          ...checks.values(),
          confirmMerge,
        ])
          gate.resolve();
        await running;
      }
    },
  );
}

await test("one failed required check holds the entire Batch while CI repair is pending", async (t) => {
  const fixture = await batchRun(t);
  fixture.state.onChecks = async (number) =>
    number === 82
      ? [{ name: "test", state: "FAILURE", link: "", bucket: "fail" }]
      : [];
  let repairStarted = false;
  const create = fixture.dependencies.terminalPlugin.createTab.bind(
    fixture.dependencies.terminalPlugin,
  );
  fixture.dependencies.terminalPlugin.createTab = async (options) => {
    const tab = await create(options);
    if (options.label.endsWith(" ci_repair")) {
      repairStarted = true;
      fixture.controller.abort();
    }
    return tab;
  };
  assert.equal((await fixture.run(["--issue"])).summary.outcome, "cancelled");
  assert.equal(repairStarted, true);
  assert.deepEqual(fixture.requests, []);
  assert.equal(
    fixture.children.every((ticket) => ticket.state === "open"),
    true,
  );
});

for (const failure of ["rejected", "conflict"] as const) {
  await test(`a later ${failure} merge retains earlier confirmed delivery without rollback or overtaking`, async (t) => {
    const fixture = await batchRun(t);
    let repairAttempts = 0;
    const submit = fixture.dependencies.terminalPlugin.submitText.bind(
      fixture.dependencies.terminalPlugin,
    );
    fixture.dependencies.terminalPlugin.submitText = async (tab, text) => {
      if (text.startsWith("Session Probe\n")) {
        const assignment = promptAssignment(text) as {
          path: string;
          role: string;
        };
        if (assignment.role !== "conflictRepair") return submit(tab, text);
        await publish(assignment.path, {
          sessionid: `conflict-session-${repairAttempts}`,
        });
      } else if (text.startsWith("Conflict repair assignment\n")) {
        const assignment = promptAssignment(text) as { path: string };
        repairAttempts++;
        await publish(assignment.path, {
          outcome: "no_change",
          summary: "Conflict remains unresolved",
          commits: [],
          findings_file: null,
        });
      } else await submit(tab, text);
    };
    let deliveredBeforeFailure:
      Awaited<ReturnType<typeof implementationProgress>> | undefined;
    fixture.state.onMerge = async (number) => {
      if (number === 83) {
        const saved = await Promise.all(
          [51, 52, 53].map((ticket) =>
            implementationProgress(fixture.directory, ticket),
          ),
        );
        deliveredBeforeFailure = saved.find(
          (progress) => progress.publication?.pullRequest?.number === 82,
        )!;
        assert.equal(deliveredBeforeFailure.publication?.phase, "delivered");
        return { outcome: failure, error: new Error("merge forbidden") };
      }
      fixture.merged.add(number);
      return { outcome: "accepted" };
    };
    fixture.dependencies.operator.pause = async (message) => {
      assert.match(
        message,
        failure === "rejected"
          ? /merge forbidden/u
          : /Conflict repair failed after two attempts/u,
      );
      return "q";
    };
    assert.equal((await fixture.run(["--issue"])).summary.outcome, "cancelled");
    assert.equal(repairAttempts, failure === "conflict" ? 2 : 0);
    assert.deepEqual(
      fixture.requests,
      failure === "rejected" ? [82, 83, 83] : [82, 83],
    );
    assert.deepEqual([...fixture.merged], [82]);
    const saved = await Promise.all(
      [51, 52, 53].map((number) =>
        implementationProgress(fixture.directory, number),
      ),
    );
    for (const progress of saved) {
      const publication = progress.publication!;
      const delivered = publication.pullRequest!.number === 82;
      assert.equal(
        publication.phase,
        delivered
          ? "delivered"
          : publication.pullRequest!.number === 83
            ? failure === "conflict"
              ? "conflict_repair"
              : "pending_merge"
            : "checks_ready",
      );
      const ticket = fixture.children.find(
        (ticket) => ticket.number === progress.ticket,
      )!;
      assert.equal(ticket.state, delivered ? "closed" : "open");
      assert.equal(ticket.stateReason, delivered ? "completed" : null);
      if (delivered) {
        assert.deepEqual(progress, deliveredBeforeFailure);
        assert.equal(publication.merge?.merged, true);
        assert.deepEqual(publication.closure, {
          state: "closed",
          stateReason: "completed",
        });
      } else {
        assert.equal(publication.merge, undefined);
        assert.equal(publication.closure, undefined);
      }
    }
  });
}
