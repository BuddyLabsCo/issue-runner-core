/* eslint-disable @typescript-eslint/require-await -- Scripted external boundaries. */
import { promptAssignment } from "../support/prompt-assignment.ts";
import assert from "node:assert/strict";
import { access, readFile, readdir, writeFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { stringify } from "yaml";
import type { CodeHost } from "../../src/run/contracts.ts";
import { child } from "../support/parent-run.ts";
import {
  batchDocumentationConfig,
  batchDocumentationRun,
  documentationNoChange,
} from "../support/batch-documentation-run.ts";
import {
  implementationProgress,
  publish,
} from "../support/implementation-run.ts";

await test("one documentation occurrence follows each matching successful Batch before later work or parent closure", async (t) => {
  const children = [51, 52, 53, 54, 55].map((number) => child(number));
  const fixture = await batchDocumentationRun(t, children);
  let fetches = 0;
  fixture.dependencies.gitWorkspace.fetchTargetBranch = async () => {
    fetches++;
    return String(fetches).repeat(40);
  };
  const close = fixture.dependencies.tracker.closeTicket.bind(
    fixture.dependencies.tracker,
  );
  fixture.dependencies.tracker.closeTicket = async (repository, number) => {
    await close(repository, number);
    if ([51, 52, 54].includes(number))
      children.find((ticket) => ticket.number === number)!.labels!.push("Docs");
  };

  const result = await fixture.run();

  assert.equal(result.summary.outcome, "succeeded", JSON.stringify(result));
  assert.equal(fixture.maintenance.length, 2);
  assert.deepEqual(
    fixture.events.map((event) =>
      /^close:5\d$/u.test(event) ? "close:issue" : event,
    ),
    [
      "implement",
      "implement",
      "implement",
      "close:issue",
      "close:issue",
      "close:issue",
      "maintenance:100",
      "document",
      "close:100",
      "implement",
      "implement",
      "close:issue",
      "close:issue",
      "maintenance:101",
      "document",
      "close:101",
      "close:48",
    ],
  );
  assert.equal(fixture.cleanup.length, 7);
  assert.equal(
    fetches,
    4,
    "each business Batch and documentation occurrence fetches its own base",
  );
  assert.equal(
    (await fixture.dependencies.codeHost.listPullRequests()).length,
    5,
  );
});

for (const labels of [["docs"], ["DOCS"], ["Docs-extra"], [" Docs "]]) {
  await test(`delivery labels ${JSON.stringify(labels)} do not match Docs exactly`, async (t) => {
    const fixture = await batchDocumentationRun(t, [
      child(51, { labels: ["ready-for-agent", ...labels] }),
    ]);
    assert.equal((await fixture.run()).summary.outcome, "succeeded");
    assert.equal(fixture.maintenance.length, 0);
  });
}

await test("removing the trigger before confirmed delivery prevents maintenance", async (t) => {
  const ticket = child(51, { labels: ["ready-for-agent", "Docs"] });
  const fixture = await batchDocumentationRun(t, [ticket]);
  const close = fixture.dependencies.tracker.closeTicket.bind(
    fixture.dependencies.tracker,
  );
  fixture.dependencies.tracker.closeTicket = async (repository, number) => {
    ticket.labels = ["ready-for-agent", "sandcastle:reserved"];
    await close(repository, number);
  };
  assert.equal((await fixture.run()).summary.outcome, "succeeded");
  assert.equal(fixture.maintenance.length, 0);
});

for (const scope of [["--issue", "51"], ["--issue"]]) {
  await test(`${scope.join(" ")} triggers documentation for its successful Batch`, async (t) => {
    const fixture = await batchDocumentationRun(
      t,
      [child(51, { labels: ["ready-for-agent", "Docs"] })],
      {
        ...batchDocumentationConfig,
        issueList: scope.length === 1 ? [51] : [99],
      },
    );
    assert.equal((await fixture.run(scope)).summary.outcome, "succeeded");
    assert.equal(fixture.maintenance.length, 1);
    assert.equal(fixture.parent.state, "open");
  });
}

await test("unmerged work never triggers documentation", async (t) => {
  const ticket = child(51, { labels: ["ready-for-agent", "Docs"] });
  const fixture = await batchDocumentationRun(t, [ticket]);
  const result = await fixture.run(["--issue", "51", "--no-auto-merge"]);
  assert.equal(result.summary.outcome, "incomplete", JSON.stringify(result));
  assert.equal(fixture.maintenance.length, 0);
});

for (const stateReason of ["not_planned", "completed"] as const) {
  await test(`numbered Issue recovery reports no_work immediately when retained work is externally ${stateReason}`, async (t) => {
    const ticket = child(51, { labels: ["ready-for-agent", "Docs"] });
    const fixture = await batchDocumentationRun(t, [ticket]);
    const flags = ["--issue", "51", "--no-auto-merge"];
    assert.equal((await fixture.run(flags)).summary.outcome, "incomplete");
    ticket.state = "closed";
    ticket.stateReason = stateReason;

    const result = await fixture.run(flags);

    assert.equal(result.summary.outcome, "no_work", JSON.stringify(result));
    assert.equal(result.exitCode, 0);
    assert.deepEqual(fixture.dispatched, [51]);
    assert.equal(fixture.maintenance.length, 0);
    assert.deepEqual(fixture.cleanup, []);
  });
}

await test("work cancelled after merge never triggers documentation", async (t) => {
  const ticket = child(51, { labels: ["ready-for-agent", "Docs"] });
  const fixture = await batchDocumentationRun(t, [ticket]);
  const close = fixture.dependencies.tracker.closeTicket.bind(
    fixture.dependencies.tracker,
  );
  fixture.dependencies.tracker.closeTicket = async (repository, number) => {
    await close(repository, number);
    if (number === 51) ticket.stateReason = "not_planned";
  };
  assert.equal((await fixture.run()).summary.outcome, "succeeded");
  assert.equal(fixture.merged.size, 1);
  assert.equal(fixture.maintenance.length, 0);
});

await test("ordinary implementation no_change earns no delivery trigger", async (t) => {
  const fixture = await batchDocumentationRun(t, [
    child(51, { labels: ["ready-for-agent", "Docs"] }),
  ]);
  const submit = fixture.dependencies.terminalPlugin.submitText.bind(
    fixture.dependencies.terminalPlugin,
  );
  fixture.dependencies.terminalPlugin.submitText = async (tab, text) => {
    if (text.startsWith("Implementation assignment\n")) {
      const assignment = promptAssignment(text) as { path: string };
      await publish(assignment.path, documentationNoChange);
    } else await submit(tab, text);
  };
  assert.equal((await fixture.run()).summary.outcome, "incomplete");
  assert.equal(fixture.merged.size, 0);
  assert.equal(fixture.maintenance.length, 0);
});

await test("a completed occurrence satisfies its restored Batch barrier without another Maintenance Ticket", async (t) => {
  const fixture = await batchDocumentationRun(t, [
    child(51, { labels: ["ready-for-agent", "Docs"] }),
  ]);
  assert.equal((await fixture.run()).summary.outcome, "succeeded");
  const recovery = path.join(fixture.directory, "recovery");
  const files = await readdir(recovery);
  const batchFile = path.join(
    recovery,
    files.find((file) => file.endsWith("-batch.json"))!,
  );
  const batch = JSON.parse(await readFile(batchFile, "utf8")) as {
    completed?: boolean;
  };
  // Reproduce interruption between maintenance completion and Batch completion persistence.
  delete batch.completed;
  await writeFile(batchFile, JSON.stringify(batch));

  assert.equal((await fixture.run()).summary.outcome, "succeeded");
  assert.equal(fixture.maintenance.length, 1);
  assert.equal(fixture.cleanup.length, 2);
  assert.equal(
    fixture.events.filter((event) => event === "document").length,
    1,
  );
});

await test("pending documentation recovers before any parent discovery, using its saved conversation and occurrence", async (t) => {
  const ticket = child(51, { labels: ["ready-for-agent", "Docs"] });
  const fixture = await batchDocumentationRun(t, [ticket]);
  fixture.state.onDocument = async () => {
    fixture.controller.abort();
  };
  assert.equal((await fixture.run()).summary.outcome, "cancelled");
  const before = await implementationProgress(fixture.directory, 100);
  ticket.labels = ["ready-for-agent"];
  const recovery = path.join(fixture.directory, "recovery");
  const files = await readdir(recovery);
  const batch = JSON.parse(
    await readFile(
      path.join(
        recovery,
        files.find((file) => file.endsWith("-batch.json"))!,
      ),
      "utf8",
    ),
  ) as { documentation: string; completed?: boolean };
  const occurrence = JSON.parse(
    await readFile(
      path.join(
        recovery,
        files.find((file) =>
          file.endsWith(`-batch-${batch.documentation}.json`),
        )!,
      ),
      "utf8",
    ),
  ) as { batch: string };
  assert.equal(occurrence.batch, batch.documentation);
  assert.equal(batch.completed, undefined);
  const getTicket = fixture.dependencies.tracker.getTicket.bind(
    fixture.dependencies.tracker,
  );
  fixture.dependencies.tracker.getTicket = async (...args) => {
    if (args[1] === 51)
      assert.equal(
        fixture.maintenance[0]!.state,
        "closed",
        "maintenance blocks business-Issue reads after restart",
      );
    return getTicket(...args);
  };
  let discovery = 0;
  const parent = fixture.dependencies.tracker.getParent.bind(
    fixture.dependencies.tracker,
  );
  fixture.dependencies.tracker.getParent = async (...args) => {
    assert.equal(
      fixture.maintenance[0]!.state,
      "closed",
      "maintenance blocks even parent reads after restart",
    );
    discovery++;
    return parent(...args);
  };
  const submit = fixture.dependencies.terminalPlugin.submitText.bind(
    fixture.dependencies.terminalPlugin,
  );
  const resumed: string[] = [];
  fixture.dependencies.terminalPlugin.submitText = async (tab, text) => {
    resumed.push(text);
    await submit(tab, text);
    if (text === "continue")
      await publish(before.invocation!.path, documentationNoChange);
  };
  fixture.dependencies.signal = new AbortController().signal;

  const result = await fixture.run();

  assert.equal(result.summary.outcome, "succeeded", JSON.stringify(result));
  assert.deepEqual(resumed, ['any-cli --resume "native-100"', "continue"]);
  assert.equal(fixture.maintenance.length, 1);
  assert.ok(discovery > 0);
  assert.equal(fixture.parent.state, "closed");
  assert.equal(
    (await implementationProgress(fixture.directory, 100)).execution_id,
    before.execution_id,
  );
  await assert.rejects(access(before.invocation!.path), { code: "ENOENT" });
  assert.equal((await fixture.run()).summary.outcome, "succeeded");
  assert.equal(fixture.maintenance.length, 1);
});

await test("changed configuration ignores the pending occurrence and retains all of its artifacts", async (t) => {
  const fixture = await batchDocumentationRun(t, [
    child(51, { labels: ["ready-for-agent", "Docs"] }),
  ]);
  fixture.state.onDocument = async () => {
    fixture.controller.abort();
  };
  assert.equal((await fixture.run()).summary.outcome, "cancelled");
  const original = await implementationProgress(fixture.directory, 100);
  const recovery = path.join(fixture.directory, "recovery");
  const files = await readdir(recovery);
  const saved = await Promise.all(
    files.map((file) => readFile(path.join(recovery, file), "utf8")),
  );
  await writeFile(
    path.join(fixture.directory, "config.yaml"),
    stringify({
      ...batchDocumentationConfig,
      targetBranch: "another-target",
    }),
  );
  fixture.dependencies.signal = new AbortController().signal;
  assert.equal((await fixture.run()).summary.outcome, "succeeded");
  assert.equal(fixture.maintenance.length, 1);
  assert.equal(fixture.maintenance[0]!.state, "open");
  assert.deepEqual(fixture.cleanup, [
    (await implementationProgress(fixture.directory, 51)).worktree,
  ]);
  await access(original.worktree);
  await access(original.probe!.path);
  assert.deepEqual(
    await Promise.all(
      files.map((file) => readFile(path.join(recovery, file), "utf8")),
    ),
    saved,
  );
});

for (const issueList of [[51], [51, 52, 53, 54]]) {
  await test(`Issue List recovery completes maintenance and all ${issueList.length} configured Issues`, async (t) => {
    const tickets = issueList.map((number) =>
      child(number, { labels: ["ready-for-agent", "Docs"] }),
    );
    const fixture = await batchDocumentationRun(t, tickets, {
      ...batchDocumentationConfig,
      issueList,
    });
    fixture.state.onDocument = async () => {
      fixture.controller.abort();
    };
    assert.equal((await fixture.run(["--issue"])).summary.outcome, "cancelled");
    if (tickets.length > 3) assert.equal(tickets[3]!.state, "open");
    const before = await implementationProgress(fixture.directory, 100);
    await publish(before.invocation!.path, documentationNoChange);
    fixture.dependencies.signal = new AbortController().signal;
    fixture.state.onDocument = (file) => publish(file, documentationNoChange);

    const result = await fixture.run(["--issue"]);

    assert.equal(result.summary.outcome, "succeeded", JSON.stringify(result));
    assert.ok(tickets.every((ticket) => ticket.state === "closed"));
    assert.equal(fixture.maintenance.length, issueList.length === 1 ? 1 : 2);
    if (tickets.length > 3)
      assert.ok(
        fixture.events.indexOf("close:100") <
          fixture.events.lastIndexOf("implement"),
      );
  });
}

await test("committed automatic documentation follows normal publication and integration without ordinary Review", async (t) => {
  const fixture = await batchDocumentationRun(t, [
    child(51, { labels: ["ready-for-agent", "Docs"] }),
  ]);
  fixture.state.onDocument = (_file, commit) => commit();
  const result = await fixture.run();
  assert.equal(result.summary.outcome, "succeeded", JSON.stringify(result));
  const progress = await implementationProgress(fixture.directory, 100);
  assert.equal(progress.publication?.phase, "delivered");
  assert.equal(progress.roles.review, undefined);
  assert.equal(
    (await fixture.dependencies.codeHost.listPullRequests()).length,
    2,
  );
  assert.equal(fixture.cleanup.length, 2);
});

await test("unsuccessful documentation blocks later Batch discovery and parent closure, retaining its artifacts", async (t) => {
  const fixture = await batchDocumentationRun(
    t,
    [child(51, { labels: ["ready-for-agent", "Docs"] }), child(52)],
    {
      ...batchDocumentationConfig,
      maxBatchSize: 1,
    },
  );
  const close = fixture.dependencies.tracker.closeTicket.bind(
    fixture.dependencies.tracker,
  );
  fixture.dependencies.tracker.closeTicket = async (repository, number) => {
    await close(repository, number);
    if (number === 100) fixture.maintenance[0]!.stateReason = "not_planned";
  };
  const list = fixture.dependencies.tracker.listChildrenPage.bind(
    fixture.dependencies.tracker,
  );
  fixture.dependencies.tracker.listChildrenPage = async (...args) => {
    assert.equal(
      fixture.maintenance.length,
      0,
      "no discovery after maintenance starts",
    );
    return list(...args);
  };
  const result = await fixture.run();
  assert.equal(result.summary.outcome, "incomplete", JSON.stringify(result));
  assert.deepEqual(fixture.dispatched, [51]);
  assert.equal(fixture.parent.state, "open");
  assert.deepEqual(fixture.cleanup, [
    (await implementationProgress(fixture.directory, 51)).worktree,
  ]);
  const progress = await implementationProgress(fixture.directory, 100);
  await access(progress.worktree);
  await access(progress.invocation!.path);
});

await test("recovery uses persisted delivery labels after a partial Batch was interrupted", async (t) => {
  const tickets = [51, 52].map((number) =>
    child(number, { labels: ["ready-for-agent", "Docs"] }),
  );
  const fixture = await batchDocumentationRun(t, tickets);
  const host: CodeHost = fixture.dependencies.codeHost;
  const merge = host.requestSquashMerge.bind(host);
  let first: number | undefined;
  host.requestSquashMerge = async (input) => {
    first ??= input.pullRequest;
    return input.pullRequest === first
      ? merge(input)
      : { outcome: "rejected", error: new Error("merge forbidden") };
  };
  fixture.dependencies.operator.pause = async () => "q";
  assert.equal((await fixture.run()).summary.outcome, "cancelled");
  const delivered = tickets.find(
    (ticket) => ticket.stateReason === "completed",
  )!;
  assert.ok(delivered);
  assert.equal(fixture.maintenance.length, 0);
  for (const ticket of tickets)
    ticket.labels = ticket.labels!.filter((label) => label !== "Docs");
  host.requestSquashMerge = merge;
  fixture.dependencies.operator.pause = async (message) => {
    assert.match(message, /merge forbidden/u);
    return "";
  };
  fixture.dependencies.signal = new AbortController().signal;
  const result = await fixture.run();
  assert.equal(result.summary.outcome, "succeeded", JSON.stringify(result));
  assert.equal(fixture.maintenance.length, 1);
  assert.equal(fixture.maintenance[0]!.state, "closed");
  assert.deepEqual(
    (await implementationProgress(fixture.directory, delivered.number))
      .publication?.deliveryLabels,
    ["ready-for-agent", "Docs", "sandcastle:reserved"],
  );
});
