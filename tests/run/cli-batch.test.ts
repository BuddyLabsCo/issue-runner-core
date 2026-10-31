/* eslint-disable @typescript-eslint/require-await -- Scripted external boundaries. */
import assert from "node:assert/strict";
import { readFile, readdir, writeFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import type { CreateTabOptions } from "../../src/terminal.ts";
import { validConfig } from "../support/cli-project.ts";
import {
  committed,
  deferred,
  publish,
  implementationProgress as progress,
} from "../support/implementation-run.ts";
import { child, parentRun } from "../support/parent-run.ts";

for (const selector of ["parent", "issue"] as const) {
  await test(`${selector} executes a bounded Batch concurrently with isolated Issue contexts and reversed completion`, async (t) => {
    const fixture = await parentRun(t, [child(53), child(52), child(51)], {
      ...validConfig,
      issueList: selector === "issue" ? [53, 52, 51] : [],
      maxBatchSize: 2,
    });
    const gates = new Map([51, 52].map((number) => [number, deferred<void>()]));
    const arrived = new Map(
      [51, 52].map((number) => [number, deferred<void>()]),
    );
    const closedSecond = deferred<void>();
    const closed: number[] = [];
    const tabs = new Map<
      object,
      { number: number; options: CreateTabOptions }
    >();
    const createTab = fixture.dependencies.terminalPlugin.createTab.bind(
      fixture.dependencies.terminalPlugin,
    );
    const submitText = fixture.dependencies.terminalPlugin.submitText.bind(
      fixture.dependencies.terminalPlugin,
    );
    fixture.dependencies.terminalPlugin.createTab = async (
      options: CreateTabOptions,
    ) => {
      const number = Number(/ticket-(\d+)$/u.exec(options.cwd)![1]);
      assert.equal(options.label, `Issue #${number} implement`);
      const tab = await createTab(options);
      tabs.set(tab, { number, options });
      return tab;
    };
    fixture.dependencies.terminalPlugin.submitText = async (tab, text) => {
      const { number } = tabs.get(tab)!;
      if (text.startsWith("Session Probe\n")) {
        const assignment = JSON.parse(text.split("\n")[1]!) as {
          ticket: number;
          path: string;
        };
        assert.equal(assignment.ticket, number);
        assert.match(
          path.basename(assignment.path),
          new RegExp(`^${number}-implement-probe-`, "u"),
        );
      }
      if (text.startsWith("Implementation assignment\n")) {
        arrived.get(number)!.resolve();
        await gates.get(number)!.promise;
        await submitText(tab, text);
        const assignment = JSON.parse(text.split("\n")[1]!) as { path: string };
        await publish(assignment.path, {
          ...committed(number),
          summary: `Completed Issue #${number}`,
        });
      } else await submitText(tab, text);
    };
    fixture.dependencies.terminalPlugin.closeTab = async (tab: object) => {
      const { number } = tabs.get(tab)!;
      closed.push(number);
      if (number === 52) closedSecond.resolve();
    };
    let fetches = 0;
    fixture.dependencies.gitWorkspace.fetchTargetBranch = async () => {
      fetches += 1;
      return "c".repeat(40);
    };
    const running = fixture.run([
      `--${selector}`,
      ...(selector === "parent" ? ["48"] : []),
    ]);
    const deadline = setTimeout(
      () =>
        arrived
          .get(52)!
          .reject(new Error("second Issue did not run concurrently")),
      3000,
    );
    try {
      await Promise.all([...arrived.values()].map(({ promise }) => promise));
      clearTimeout(deadline);
      assert.equal(tabs.size, 2);
      assert.equal(fetches, 1);
      const contexts = [...tabs.values()];
      const configs = contexts.map(
        ({ options }) => options.env.GIT_CONFIG_GLOBAL!,
      );
      assert.equal(new Set(configs).size, 2);
      for (const file of configs)
        assert.match(await readFile(file, "utf8"), /name = Issue Runner/u);
      const before = await Promise.all(
        [51, 52].map((number) => progress(fixture.directory, number)),
      );
      assert.equal(new Set(before.map((item) => item.execution_id)).size, 2);
      assert.equal(new Set(before.map((item) => item.branch)).size, 2);
      assert.equal(
        new Set(
          before.flatMap((item) => [item.probe!.path, item.invocation!.path]),
        ).size,
        4,
      );
      for (const item of before) {
        assert.equal(item.base, "c".repeat(40));
        assert.equal(item.roles.implement!.sessionid, `native-${item.ticket}`);
        assert.match(item.pr_body!, new RegExp(`Closes #${item.ticket}$`, "u"));
        assert.ok(
          fixture.writes.indexOf(`label:${item.ticket}`) <
            fixture.writes.indexOf(`assignee:${item.ticket}`),
        );
      }
      gates.get(52)!.resolve();
      await closedSecond.promise;
      assert.deepEqual(closed, [52]);
      assert.equal(
        (await progress(fixture.directory, 51)).phase,
        "implementing",
      );
      assert.equal(
        (await progress(fixture.directory, 52)).result!.summary,
        "Completed Issue #52",
      );
      gates.get(51)!.resolve();
      const result = await running;
      assert.equal(result.summary.outcome, "incomplete");
      assert.deepEqual(closed, [52, 51]);
      assert.equal(
        (await progress(fixture.directory, 51)).result!.summary,
        "Completed Issue #51",
      );
      assert.deepEqual([...fixture.dispatched].sort(), [51, 52]);
      assert.equal(
        fixture.writes.some((write) => write.endsWith(":53")),
        false,
      );
      for (const file of configs)
        await assert.rejects(readFile(file), { code: "ENOENT" });
    } finally {
      clearTimeout(deadline);
      for (const gate of gates.values()) gate.resolve();
      await running;
    }
  });

  await test(`${selector} recovery retains Batch membership when a recorded Issue becomes ineligible`, async (t) => {
    const tickets = [child(51), child(52), child(53, { labels: [] })];
    const fixture = await parentRun(t, tickets, {
      ...validConfig,
      issueList: selector === "issue" ? [51, 52, 53] : [],
      maxBatchSize: 2,
    });
    const scope = [`--${selector}`, ...(selector === "parent" ? ["48"] : [])];
    await fixture.run(scope);
    const original = await progress(fixture.directory, 52);
    tickets[0]!.labels = ["sandcastle:reserved"];
    tickets[2]!.labels = ["ready-for-agent"];

    const result = await fixture.run(scope);

    assert.equal(result.summary.outcome, "incomplete");
    assert.match(
      result.summary.reasons.join("; "),
      /selected Delivery Tickets: 51, 52/u,
    );
    assert.deepEqual([...fixture.dispatched].sort(), [51, 52]);
    assert.equal(
      fixture.writes.some((write) => write.endsWith(":53")),
      false,
    );
    assert.deepEqual(await progress(fixture.directory, 52), original);
  });
}

await test("a recorded Batch survives cancellation before any Issue checkpoint and cannot be replaced", async (t) => {
  const tickets = [child(51), child(52), child(53)];
  const fixture = await parentRun(t, tickets, {
    ...validConfig,
    maxBatchSize: 2,
  });
  fixture.dependencies.tracker.addLabel = async () => {
    fixture.controller.abort();
  };
  assert.equal((await fixture.run()).summary.outcome, "cancelled");
  const recovery = path.join(fixture.directory, "recovery");
  const files = await readdir(recovery);
  assert.equal(files.length, 1);
  const saved = await readFile(path.join(recovery, files[0]!), "utf8");
  assert.deepEqual(
    (JSON.parse(saved) as { tickets: number[] }).tickets,
    [51, 52],
  );
  tickets[0]!.labels = [];
  tickets[1]!.labels = [];
  fixture.dependencies.signal = new AbortController().signal;

  const result = await fixture.run();

  assert.equal(result.summary.outcome, "incomplete");
  assert.match(
    result.summary.reasons.join("; "),
    /selected Delivery Tickets: 51, 52/u,
  );
  assert.deepEqual(fixture.dispatched, []);
  assert.equal(await readFile(path.join(recovery, files[0]!), "utf8"), saved);
});

await test("overlapping parent pages cannot dispatch the same Issue concurrently or consume its Batch slot twice", async (t) => {
  const fixture = await parentRun(t, [child(51), child(52)], {
    ...validConfig,
    maxBatchSize: 2,
  });
  fixture.dependencies.tracker.listChildrenPage = async (
    _repository,
    _parent,
    page,
  ) => ({
    children: page === 1 ? [child(51)] : [child(51), child(52)],
    nextPage: page === 1 ? 2 : null,
  });
  const result = await fixture.run();
  assert.equal(
    result.summary.outcome,
    "incomplete",
    JSON.stringify(result.summary),
  );
  assert.deepEqual([...fixture.dispatched].sort(), [51, 52]);
  assert.match(
    result.summary.reasons.join("; "),
    /selected Delivery Tickets: 51, 52/u,
  );
});

await test("invalid Batch ownership or membership fails closed before dispatch", async (t) => {
  const fixture = await parentRun(t, [child(51), child(52), child(53)], {
    ...validConfig,
    maxBatchSize: 2,
  });
  await fixture.run();
  const recovery = path.join(fixture.directory, "recovery");
  const file = (await readdir(recovery)).find((name) =>
    name.endsWith("-batch.json"),
  )!;
  const saved = JSON.parse(
    await readFile(path.join(recovery, file), "utf8"),
  ) as object;
  fixture.dependencies.terminalPlugin.createTab = async () =>
    assert.fail("invalid Batch cannot dispatch");
  for (const patch of [
    { repository: "outside/repo" },
    { target_branch: "different" },
    { input_hash: "different" },
    { run_id: "" },
    { completed: "true" },
    { tickets: [51, 51] },
    { tickets: [52, 51] },
    { tickets: [51, 52, 53] },
    { tickets: [0] },
    { tickets: [] },
  ]) {
    await writeFile(
      path.join(recovery, file),
      JSON.stringify({ ...saved, ...patch }),
    );
    const result = await fixture.run();
    assert.equal(result.summary.outcome, "failed");
    assert.match(
      result.summary.reasons.join("; "),
      /invalid Batch checkpoint/u,
    );
  }
});

await test("a failed Issue cancels a sibling's delayed startup and waits for its resources to be retained", async (t) => {
  const fixture = await parentRun(t, [child(51), child(52)]);
  const siblingStarted = deferred<void>();
  const releaseSibling = deferred<void>();
  let starts = 0;
  fixture.dependencies.clock.sleep = async (ms) => {
    assert.equal(ms, 10_000);
    starts += 1;
    if (starts === 1) await siblingStarted.promise;
    else {
      siblingStarted.resolve();
      await releaseSibling.promise;
    }
  };
  const submitText = fixture.dependencies.terminalPlugin.submitText.bind(
    fixture.dependencies.terminalPlugin,
  );
  let failureStarted = false;
  fixture.dependencies.terminalPlugin.submitText = async (tab, text) => {
    if (text.startsWith("Implementation assignment\n")) {
      failureStarted = true;
      releaseSibling.resolve();
      throw new Error("Issue transport failed");
    }
    assert.equal(
      failureStarted,
      false,
      "no follow-ups after a sibling failure",
    );
    await submitText(tab, text);
  };
  const result = await fixture.run();
  assert.equal(result.summary.outcome, "failed");
  assert.match(result.summary.reasons.join("; "), /Issue transport failed/u);
  assert.deepEqual(fixture.dispatched, []);
  const checkpoints = await Promise.all(
    [51, 52].map((number) => progress(fixture.directory, number)),
  );
  assert.equal(
    checkpoints.some((item) => item.phase === "implementing"),
    true,
  );
  assert.equal(
    checkpoints.some((item) => item.phase === "probing"),
    true,
  );
});

await test("concurrent Git failures serialize non-Agent Operator Pauses before retrying", async (t) => {
  const fixture = await parentRun(t, [child(51), child(52)], {
    ...validConfig,
    operationRetry: 0,
  });
  const inspect = fixture.dependencies.gitWorkspace.inspect.bind(
    fixture.dependencies.gitWorkspace,
  );
  const failed = new Set<string>();
  fixture.dependencies.gitWorkspace.inspect = async (input) => {
    if (!failed.has(input.worktree)) {
      failed.add(input.worktree);
      throw new Error("Git temporarily unavailable");
    }
    return inspect(input);
  };
  let active = 0;
  let pauses = 0;
  fixture.dependencies.operator.pause = async (message) => {
    if (message.includes("Integration is not scripted in this fixture"))
      return "s";
    active += 1;
    assert.equal(
      active,
      1,
      "only one question may read operator input at a time",
    );
    pauses += 1;
    await new Promise<void>((resolve) => setTimeout(resolve, 100));
    active -= 1;
    return "";
  };
  const result = await fixture.run();
  assert.equal(
    result.summary.outcome,
    "incomplete",
    JSON.stringify(result.summary),
  );
  assert.equal(pauses, 2);
  assert.deepEqual([...fixture.dispatched].sort(), [51, 52]);
});

await test("q at an Operator Pause cancels the Batch before queued questions or retries", async (t) => {
  const fixture = await parentRun(t, [child(51), child(52)], {
    ...validConfig,
    operationRetry: 0,
  });
  fixture.dependencies.gitWorkspace.inspect = async () => {
    throw new Error("Git unavailable");
  };
  let pauses = 0;
  fixture.dependencies.operator.pause = async () => {
    assert.equal(++pauses, 1, "queued questions must stop after cancellation");
    await new Promise<void>((resolve) => setTimeout(resolve, 100));
    return "q";
  };
  assert.equal((await fixture.run()).summary.outcome, "cancelled");
  assert.equal(pauses, 1);
  assert.deepEqual(fixture.dispatched, []);
});
