/* eslint-disable @typescript-eslint/require-await -- Scripted external boundaries. */
import assert from "node:assert/strict";
import { access, readFile, rm, writeFile } from "node:fs/promises";
import test from "node:test";
import type { CodeHost } from "../../src/run/contracts.ts";
import type { TerminalPlugin } from "../../src/terminal.ts";
import { fiveIssueRun } from "../support/full-contract-run.ts";
import {
  committed,
  deferred,
  implementationProgress,
  publish,
} from "../support/implementation-run.ts";

await test(
  "five-Issue Run retries a Reservation and accepts native manual correction after automatic exhaustion",
  { timeout: 10_000 },
  async (t) => {
    const fixture = await fiveIssueRun(t);
    const tracker = fixture.dependencies.tracker;
    const reserve = tracker.addLabel.bind(tracker);
    let reservationAttempts = 0;
    tracker.addLabel = async (repository, number, label) => {
      if (number === 51 && ++reservationAttempts === 1)
        throw new Error("Reservation unavailable");
      await reserve(repository, number, label);
    };
    const terminal: TerminalPlugin = fixture.dependencies.terminalPlugin;
    const submit = terminal.submitText.bind(terminal);
    const invalidPaths: string[] = [];
    let correctedTab: object | undefined;
    terminal.submitText = async (tab, text, chord) => {
      if (fixture.tabs.get(tab)!.cwd.endsWith("ticket-52")) {
        if (text.startsWith("Implementation assignment\n")) {
          await submit(tab, text, chord);
          correctedTab = tab;
          const saved = await implementationProgress(fixture.directory, 52);
          invalidPaths.push(saved.invocation!.path);
          await writeFile(saved.invocation!.path, "{");
          return;
        }
        if (text.startsWith("Correct the implementation handoff:")) {
          assert.equal(tab, correctedTab);
          assert.equal(chord, "Shift+Enter");
          const saved = await implementationProgress(fixture.directory, 52);
          invalidPaths.push(saved.invocation!.path);
          await publish(saved.invocation!.path, {
            ...committed(52),
            outcome: "blocked",
          });
          return;
        }
      }
      await submit(tab, text, chord);
    };
    const sleep = fixture.dependencies.clock.sleep.bind(
      fixture.dependencies.clock,
    );
    let manualWrites = 0;
    fixture.dependencies.clock.sleep = async (ms) => {
      if (ms === 250 && invalidPaths.length === 3 && manualWrites === 0) {
        const saved = await implementationProgress(fixture.directory, 52);
        assert.equal(saved.corrections, 2);
        assert.equal(saved.result, undefined);
        assert.equal(saved.invocation!.path, invalidPaths[2]);
        assert.ok(fixture.active.has(correctedTab!));
        assert.ok(
          fixture.dependencies.messages.some((message) =>
            message.startsWith("Automatic correction budget exhausted."),
          ),
        );
        assert.deepEqual(fixture.integrations, []);
        manualWrites++;
        await publish(saved.invocation!.path, committed(52));
      }
      await sleep(ms);
    };

    const result = await fixture.run();

    assert.equal(result.summary.outcome, "succeeded", JSON.stringify(result));
    assert.equal(result.exitCode, 0);
    assert.equal(reservationAttempts, 2);
    assert.equal(manualWrites, 1);
    assert.equal(new Set(invalidPaths).size, 3);
    const saved = await implementationProgress(fixture.directory, 52);
    assert.equal(saved.corrections, 2);
    assert.deepEqual(saved.superseded, invalidPaths.slice(0, 2));
    assert.equal(saved.roles.implement?.sessionid, "native-52");
    assert.deepEqual(fixture.integrations, [51, 52, 53, 100, 54, 101, 55]);
    assert.deepEqual(fixture.dependencies.pauses, []);
    assert.equal(fixture.active.size, 0);
    for (const file of invalidPaths)
      await assert.rejects(access(file), { code: "ENOENT" });
  },
);

await test(
  "cancelling a missing native handoff retains the Batch and resumes only unfinished work before both maintenance barriers",
  { timeout: 10_000 },
  async (t) => {
    const fixture = await fiveIssueRun(t);
    const terminal: TerminalPlugin = fixture.dependencies.terminalPlugin;
    const submit = terminal.submitText.bind(terminal);
    terminal.submitText = async (tab, text, chord) => {
      await submit(tab, text, chord);
      if (
        fixture.tabs.get(tab)!.cwd.endsWith("ticket-53") &&
        text.startsWith("Implementation assignment\n")
      ) {
        const saved = await implementationProgress(fixture.directory, 53);
        await rm(saved.invocation!.path);
      }
    };
    const ready = new Set<number>();
    const siblingsReady = deferred<void>();
    const host: CodeHost = fixture.dependencies.codeHost;
    host.getRequiredChecks = async (_repository, number) => {
      ready.add(number);
      if (ready.size === 2) siblingsReady.resolve();
      return [];
    };
    const sleep = fixture.dependencies.clock.sleep.bind(
      fixture.dependencies.clock,
    );
    fixture.dependencies.clock.sleep = async (ms) => {
      if (ms === 250) {
        await siblingsReady.promise;
        fixture.controller.abort();
      }
      await sleep(ms);
    };
    const first = await fixture.run();
    assert.equal(first.summary.outcome, "cancelled", JSON.stringify(first));
    assert.equal(first.exitCode, 1);
    assert.deepEqual(fixture.integrations, []);
    assert.deepEqual([...fixture.dispatched].sort(), [51, 52, 53]);
    assert.equal(fixture.maintenance.length, 0);
    assert.equal(fixture.parent.state, "open");
    const before = await Promise.all(
      [51, 52, 53].map((number) =>
        implementationProgress(fixture.directory, number),
      ),
    );
    const unfinished = before[2]!;
    assert.equal(unfinished.phase, "implementing");
    assert.equal(unfinished.result, undefined);
    assert.equal(unfinished.roles.implement?.sessionid, "native-53");
    for (const saved of before) {
      await access(saved.worktree);
      await access(saved.probe!.path);
      assert.ok(
        first.summary.reasons.some((reason) => reason.includes(saved.worktree)),
      );
    }
    assert.ok(
      first.summary.tickets?.some(
        (ticket) => ticket.ticket === 53 && ticket.status === "cancelled",
      ),
    );
    const previousSubmissions = fixture.submissions.length;
    // The operator stops leftover native sessions before matching-input recovery.
    for (const tab of [...fixture.active]) await terminal.closeTab(tab);
    fixture.dependencies.signal = new AbortController().signal;
    fixture.dependencies.clock.sleep = sleep;
    terminal.submitText = async (tab, text, chord) => {
      await submit(tab, text, chord);
      if (text === "continue") {
        assert.equal(fixture.tabs.get(tab)!.cwd, unfinished.worktree);
        await publish(unfinished.invocation!.path, committed(53));
      }
    };

    const result = await fixture.run();

    assert.equal(result.summary.outcome, "succeeded", JSON.stringify(result));
    assert.equal(result.exitCode, 0);
    const resumed = fixture.submissions
      .slice(previousSubmissions)
      .filter(
        (submission) =>
          fixture.tabs.get(submission.tab)!.label === "Issue #53 implement",
      );
    assert.deepEqual(
      resumed.map((submission) => submission.text),
      ['any-cli --resume "native-53"', "continue"],
    );
    assert.equal(resumed[1]!.chord, "Shift+Enter");
    assert.equal(
      fixture.submissions
        .slice(previousSubmissions)
        .some((submission) =>
          /ticket-5[12]$/u.test(fixture.tabs.get(submission.tab)!.cwd),
        ),
      false,
    );
    assert.deepEqual(
      [...fixture.dispatched].sort(),
      [51, 52, 53, 54, 55, 100, 101].sort(),
    );
    assert.deepEqual(fixture.integrations, [51, 52, 53, 100, 54, 101, 55]);
    for (const original of before) {
      const saved = await implementationProgress(
        fixture.directory,
        original.ticket,
      );
      assert.equal(saved.execution_id, original.execution_id);
      assert.deepEqual(saved.invocation, original.invocation);
      assert.deepEqual(saved.roles.implement, original.roles.implement);
      assert.equal(saved.pr_body, original.pr_body);
      assert.equal(saved.publication?.phase, "delivered");
      await assert.rejects(access(saved.worktree), { code: "ENOENT" });
    }
    assert.equal(fixture.parent.stateReason, "completed");
    assert.equal(fixture.active.size, 0);
    assert.ok(result.logPath);
    assert.ok(
      (await readFile(result.logPath, "utf8")).includes('"result":"succeeded"'),
    );
  },
);
