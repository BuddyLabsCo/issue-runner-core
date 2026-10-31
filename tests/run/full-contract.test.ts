import assert from "node:assert/strict";
import { access, mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import type { AuditEvent } from "../../src/audit.ts";
import type { BatchProgress, MaintenanceProgress } from "../../src/recovery.ts";
import type { CodeHost } from "../../src/run/contracts.ts";
import type { TerminalPlugin } from "../../src/terminal.ts";
import { fiveIssueRun } from "../support/full-contract-run.ts";
import { agent } from "../support/cli-project.ts";
import {
  deferred,
  implementationProgress,
  committed,
} from "../support/implementation-run.ts";
import { fixCommit } from "../support/review-run.ts";

await test(
  "five Issues complete through Review and two maintenance barriers with Batch size three",
  { timeout: 10_000 },
  async (t) => {
    const fixture = await fiveIssueRun(t);
    const list = fixture.dependencies.tracker.listChildrenPage.bind(
      fixture.dependencies.tracker,
    );
    fixture.dependencies.tracker.listChildrenPage = async (...args) => {
      assert.ok(
        fixture.maintenance.every(
          (ticket) => ticket.stateReason === "completed",
        ),
        "maintenance completes before later discovery",
      );
      return list(...args);
    };
    const assigned = new Map(
      [51, 52, 53].map((number) => [number, deferred<void>()]),
    );
    const tasks = new Map(
      [51, 52, 53].map((number) => [number, deferred<void>()]),
    );
    const checked = new Map(
      [51, 52, 53].map((number) => [number, deferred<void>()]),
    );
    const ciGate = deferred<void>();
    const terminal: TerminalPlugin = fixture.dependencies.terminalPlugin;
    const submit = terminal.submitText.bind(terminal);
    terminal.submitText = async (tab, text, chord) => {
      const number = Number(
        /ticket-(\d+)$/u.exec(fixture.tabs.get(tab)!.cwd)![1],
      );
      if (text.startsWith("Implementation assignment\n") && tasks.has(number)) {
        assigned.get(number)!.resolve();
        await tasks.get(number)!.promise;
      }
      await submit(tab, text, chord);
    };
    const host: CodeHost = fixture.dependencies.codeHost;
    const checkCalls = new Map<number, number>();
    host.getRequiredChecks = async (_repository, prNumber) => {
      const pr = (await host.listPullRequests("owner/repo")).find(
        (pr) => pr.number === prNumber,
      )!;
      const number = Number(/ticket-(\d+)$/u.exec(pr.branch)![1]);
      const calls = (checkCalls.get(number) ?? 0) + 1;
      checkCalls.set(number, calls);
      checked.get(number)?.resolve();
      if (number === 51) {
        if (calls === 1)
          return [
            { name: "test", state: "PENDING", link: "", bucket: "pending" },
          ];
        await ciGate.promise;
      }
      return [{ name: "test", state: "SUCCESS", link: "", bucket: "pass" }];
    };
    const reserve = fixture.dependencies.tracker.addLabel.bind(
      fixture.dependencies.tracker,
    );
    fixture.dependencies.tracker.addLabel = async (
      repository,
      number,
      label,
    ) => {
      if (number === 54) assert.ok(fixture.events.includes("close:100"));
      if (number === 55) {
        assert.ok(fixture.events.includes("close:101"));
        assert.ok(
          fixture.children
            .filter((ticket) => ticket.number !== 55)
            .every((ticket) => ticket.stateReason === "completed"),
        );
      }
      await reserve(repository, number, label);
    };
    const handoffs = path.join(fixture.directory, "handoffs");
    await mkdir(handoffs, { recursive: true });
    const unrelated = [
      path.join(handoffs, "unrelated.json"),
      path.join(fixture.directory, "native-history.txt"),
    ];
    for (const file of unrelated)
      await writeFile(file, "Keep operator resources");

    const running = fixture.run();
    let result;
    try {
      await Promise.race([
        Promise.all([...assigned.values()].map((gate) => gate.promise)),
        running,
      ]);
      assert.equal(fixture.active.size, 3);
      for (const number of [53, 52, 51]) {
        tasks.get(number)!.resolve();
        await Promise.race([checked.get(number)!.promise, running]);
        assert.deepEqual(
          fixture.integrations,
          [],
          "CI barrier holds the whole Batch",
        );
      }
      ciGate.resolve();
      result = await running;
    } finally {
      fixture.controller.abort();
      for (const gate of [...tasks.values(), ciGate]) gate.resolve();
      await running;
    }
    assert.equal(result.summary.outcome, "succeeded", JSON.stringify(result));
    assert.equal(result.exitCode, 0);
    assert.deepEqual(fixture.dispatched, [53, 52, 51, 100, 54, 101, 55]);
    assert.deepEqual(
      fixture.writes.filter((write) => write.startsWith("label:")).sort(),
      [51, 52, 53, 54, 55].map((number) => `label:${number}`),
    );
    assert.equal(fixture.maxActive, 3);
    assert.equal(checkCalls.get(51), 2);
    assert.deepEqual(fixture.integrations, [51, 52, 53, 100, 54, 101, 55]);
    assert.deepEqual(
      fixture.events.filter((event) =>
        /^(merge:|maintenance:|close:)/u.test(event),
      ),
      [
        "merge:51",
        "close:51",
        "merge:52",
        "close:52",
        "merge:53",
        "close:53",
        "maintenance:100",
        "merge:100",
        "close:100",
        "merge:54",
        "close:54",
        "maintenance:101",
        "merge:101",
        "close:101",
        "merge:55",
        "close:55",
        "close:48",
      ],
    );
    assert.equal(fixture.parent.stateReason, "completed");
    assert.deepEqual(
      fixture.maintenance.map((ticket) => ticket.stateReason),
      ["completed", "completed"],
    );
    assert.equal(fixture.active.size, 0);
    assert.equal(fixture.closed.length, 14);
    assert.deepEqual(
      fixture.closed.filter((label) => label.startsWith("Issue #51 ")),
      [
        "Issue #51 implement",
        "Issue #51 review",
        "Issue #51 fix_review",
        "Issue #51 review",
      ],
    );
    const issue51 = fixture.submissions.filter((submission) =>
      fixture.tabs.get(submission.tab)!.cwd.endsWith("ticket-51"),
    );
    assert.deepEqual(
      issue51
        .filter((submission) => submission.chord === "Enter")
        .map((submission) => submission.text),
      [
        agent.start,
        agent.start,
        'any-cli --resume "native-51"',
        'any-cli --resume "review-51"',
      ],
    );
    for (const submission of fixture.submissions)
      assert.equal(
        submission.chord,
        submission.text.startsWith("any-cli") ? "Enter" : "Shift+Enter",
      );
    for (const tab of fixture.tabs.keys()) {
      const texts = fixture.submissions
        .filter((submission) => submission.tab === tab)
        .map((submission) => submission.text);
      assert.match(texts[0]!, /^any-cli /u);
      if (texts[0]!.includes("--resume")) assert.equal(texts.length, 2);
      else {
        assert.equal(texts.length, 3);
        assert.match(texts[1]!, /^Session Probe\n/u);
      }
      assert.match(
        texts.at(-1)!,
        /^(Implementation|Review|Fix|Documentation) assignment\n/u,
      );
    }
    const saved = await Promise.all(
      [51, 52, 53, 54, 55, 100, 101].map((number) =>
        implementationProgress(fixture.directory, number),
      ),
    );
    assert.equal(
      new Set(saved.map((progress) => progress.execution_id)).size,
      7,
    );
    for (const progress of saved) {
      assert.equal(progress.publication?.phase, "delivered");
      assert.equal(progress.publication.merge?.merged, true);
      assert.deepEqual(progress.publication.closure, {
        state: "closed",
        stateReason: "completed",
      });
      assert.equal(
        progress.publication.title,
        `feat: [issue-${progress.ticket}] implement`,
      );
      assert.equal(
        progress.publication.body,
        `Implement.\n\nCloses #${progress.ticket}`,
      );
      assert.ok(progress.cleanup?.worktrees.includes(progress.worktree));
      await assert.rejects(access(progress.worktree), { code: "ENOENT" });
      for (const stage of [
        progress,
        ...(progress.reviews ?? []).flatMap((round) => [round, round.fix]),
      ]) {
        for (const file of [stage?.probe?.path, stage?.invocation?.path]) {
          if (file) {
            await assert.rejects(access(file), { code: "ENOENT" });
            assert.ok(progress.cleanup?.files.includes(file));
          }
        }
      }
      if (progress.purpose === "documentation")
        assert.equal(progress.reviews, undefined);
      else {
        assert.equal(
          progress.roles.implement?.sessionid,
          `native-${progress.ticket}`,
        );
        assert.equal(
          progress.roles.review?.sessionid,
          `review-${progress.ticket}`,
        );
        assert.equal(progress.reviews?.at(-1)?.result?.outcome, "passed");
      }
    }
    const reviewed = saved[0]!;
    assert.deepEqual(reviewed.publication?.commits, [
      ...committed(51).commits,
      fixCommit,
    ]);
    await assert.rejects(access(reviewed.reviews![0]!.findings), {
      code: "ENOENT",
    });
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
    ) as BatchProgress;
    assert.deepEqual(batch.tickets, [55]);
    assert.equal(batch.completed, true);
    const occurrences = await Promise.all(
      files
        .filter((file) => /-batch-.+\.json$/u.test(file))
        .map(
          async (file) =>
            JSON.parse(
              await readFile(path.join(recovery, file), "utf8"),
            ) as MaintenanceProgress,
        ),
    );
    assert.deepEqual(
      occurrences.map((progress) => progress.ticket).sort(),
      [100, 101],
    );
    assert.ok(occurrences.every((progress) => progress.phase === "completed"));
    assert.deepEqual(await readdir(handoffs), ["unrelated.json"]);
    for (const file of unrelated)
      assert.equal(await readFile(file, "utf8"), "Keep operator resources");
    assert.deepEqual(
      result.summary.tickets?.map(
        ({ ticket, kind, status, retainedWorktrees }) => ({
          ticket,
          kind,
          status,
          retainedWorktrees,
        }),
      ),
      [51, 52, 53, 100, 54, 101, 55].map((ticket) => ({
        ticket,
        kind: ticket >= 100 ? "maintenance" : "delivery",
        status: "completed",
        retainedWorktrees: [],
      })),
    );
    assert.ok(
      result.summary.tickets?.every(
        (ticket) =>
          ticket.pullRequest !== null &&
          ticket.pullRequestUrl?.startsWith(
            "https://github.com/owner/repo/pull/",
          ),
      ),
    );
    assert.match(
      fixture.dependencies.messages.at(-1)!,
      /^demo: succeeded targetBranch=default-branch/u,
    );
    assert.deepEqual(fixture.dependencies.pauses, []);
    assert.ok(result.logPath);
    const audit = await readFile(result.logPath, "utf8");
    const records = audit
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as AuditEvent);
    assert.equal(
      records.filter(
        (record) =>
          record.operation === "create_maintenance_ticket" &&
          record.result === "succeeded",
      ).length,
      2,
    );
    assert.equal(records.at(-1)?.phase, "complete");
    assert.equal(records.at(-1)?.result, "succeeded");
  },
);
