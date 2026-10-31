import assert from "node:assert/strict";
import { watch } from "node:fs";
import { mkdir } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { validConfig } from "../support/cli-project.ts";
import {
  deferred,
  implementationProgress,
} from "../support/implementation-run.ts";
import { child, parentRun } from "../support/parent-run.ts";

for (const response of ["", "q", null] as const) {
  await test(`a sibling pause before PR dispatch requires ${response === "" ? "Enter before creation" : response === "q" ? "q to cancel creation" : "EOF to cancel creation"}`, async (t) => {
    const fixture = await parentRun(t, [child(51), child(52)], {
      ...validConfig,
      operationRetry: 0,
    });
    const releaseInspection = deferred<void>();
    const paused = deferred<void>();
    const answer = deferred<string | null>();
    let failed = false;
    let waiting = false;
    let armed = false;
    let listings = 0;
    let creations = 0;
    const inspect = fixture.dependencies.gitWorkspace.inspect.bind(
      fixture.dependencies.gitWorkspace,
    );
    fixture.dependencies.gitWorkspace.inspect = async (input) => {
      if (input.worktree.endsWith("ticket-51") && !failed) {
        failed = true;
        await releaseInspection.promise;
        throw new Error("Sibling Git unavailable");
      }
      return inspect(input);
    };
    fixture.dependencies.operator.pause = async () => {
      waiting = true;
      paused.resolve();
      const result = await answer.promise;
      waiting = false;
      return result;
    };
    const host = fixture.dependencies.codeHost;
    const list = host.listPullRequests.bind(host);
    host.listPullRequests = () => {
      if (++listings === 2) armed = true;
      return list();
    };
    const create = host.createPullRequest.bind(host);
    host.createPullRequest = (input) => {
      creations++;
      assert.equal(
        waiting,
        false,
        "PR creation must wait for the sibling pause",
      );
      return create(input);
    };
    const recovery = path.join(fixture.directory, "recovery");
    await mkdir(recovery);
    // Start the sibling pause at the final checkpoint, after the outer operation gate.
    const watcher = watch(recovery, (event, filename) => {
      if (armed && event === "rename" && filename?.endsWith("-52.json")) {
        armed = false;
        releaseInspection.resolve();
      }
    });
    const running = fixture.run();
    let timeout: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([
        paused.promise,
        new Promise<never>((_resolve, reject) => {
          timeout = setTimeout(
            () => reject(new Error("Sibling pause did not start")),
            3000,
          );
        }),
      ]);
      clearTimeout(timeout);
      await new Promise<void>((resolve) => setTimeout(resolve, 100));
      assert.equal(creations, 0);
      assert.equal(
        (await implementationProgress(fixture.directory, 52)).publication
          ?.phase,
        "pending_pr",
      );
    } finally {
      clearTimeout(timeout);
      watcher.close();
      releaseInspection.resolve();
      answer.resolve(response);
      await running;
    }
    const result = await running;
    assert.equal(
      result.summary.outcome,
      response === "" ? "incomplete" : "cancelled",
      JSON.stringify(result),
    );
    assert.equal(creations, response === "" ? 2 : 0);
  });
}
