/* eslint-disable @typescript-eslint/require-await -- Scripted external boundaries. */
import { promptAssignment } from "../support/prompt-assignment.ts";
import assert from "node:assert/strict";
import { mkdirSync, readdirSync, renameSync } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import {
  committed,
  deferred,
  implementationRun,
  publish,
} from "../support/implementation-run.ts";
import { child, parentDeliveryRun } from "../support/parent-run.ts";
import { integrationRun } from "../support/integration-run.ts";

await test("reports keep selection order when native implementations finish in reverse order", async (t) => {
  const fixture = await parentDeliveryRun(t, [child(52), child(51)]);
  const second = deferred<void>();
  const finished: number[] = [];
  const submit = fixture.dependencies.terminalPlugin.submitText.bind(
    fixture.dependencies.terminalPlugin,
  );
  fixture.dependencies.terminalPlugin.submitText = async (tab, text) => {
    if (!text.startsWith("Implementation assignment\n"))
      return submit(tab, text);
    const { path: handoff } = promptAssignment(text) as {
      path: string;
    };
    const ticket = Number(
      /^(\d+)-implement-/u.exec(path.basename(handoff))![1],
    );
    if (ticket === 51) await second.promise;
    await submit(tab, text);
    finished.push(ticket);
    if (ticket === 52) second.resolve();
  };
  const result = await fixture.run();
  assert.deepEqual(finished, [52, 51]);
  assert.equal(result.exitCode, 0);
  assert.equal(result.summary.outcome, "succeeded");
  assert.deepEqual(
    result.summary.tickets?.map(({ ticket, status }) => ({ ticket, status })),
    [
      { ticket: 51, status: "completed" },
      { ticket: 52, status: "completed" },
    ],
  );
  const rows = fixture.dependencies.messages.filter((message) =>
    /Issue #\d+ delivery: /u.test(message),
  );
  assert.match(rows[0]!, /^Issue #51/u);
  assert.match(rows[1]!, /^Issue #52/u);
});

for (const outcome of ["failed", "cancelled"] as const) {
  await test(`${outcome} preserves structured reports, target branch, and retained resources`, async (t) => {
    const fixture = await implementationRun(t);
    fixture.state.onTask = async (file) => {
      await writeFile(`${file}.tmp`, "unfinished handoff");
      if (outcome === "cancelled") fixture.controller.abort();
      else throw new Error("transport failure after assignment");
    };
    const result = await fixture.run();
    assert.equal(result.exitCode, 1);
    assert.equal(result.summary.outcome, outcome);
    assert.equal(result.summary.targetBranch, "default-branch");
    assert.equal(result.summary.tickets?.[0]?.status, outcome);
    const saved = await fixture.snapshot();
    assert.ok(
      result.summary.tickets[0].retainedWorktrees.includes(saved.worktree),
    );
    assert.ok(
      result.summary.reasons.some((reason) =>
        reason.includes(saved.invocation!.path),
      ),
    );
    assert.equal(fixture.state.ticket.state, "open");
  });
}

await test("workflow audit errors redact credentials without recording task or Agent output", async (t) => {
  const fixture = await implementationRun(t);
  let attempts = 0;
  fixture.dependencies.tracker.listBlockersPage = async () => {
    if (++attempts === 1) throw new Error('tracker-secret\n"host-secret"');
    return { blockers: [], nextPage: null };
  };
  const result = await fixture.run();
  const audit = await readFile(result.logPath!, "utf8");
  assert.doesNotMatch(
    audit,
    /tracker-secret|host-secret|Implemented and verified|Session Probe|Implementation assignment/u,
  );
  const events = audit
    .trim()
    .split("\n")
    .map(
      (line) => JSON.parse(line) as { result: string; error: string | null },
    );
  assert.ok(
    events.some(
      (event) =>
        event.result === "failed" && event.error?.includes("[redacted]"),
    ),
  );
  assert.equal(
    (await fixture.snapshot()).result?.summary,
    "Implemented and verified.",
  );
});

await test("a CI-ready unmerged PR has a structured report without successful delivery credit", async (t) => {
  const fixture = await implementationRun(t);
  const result = await fixture.run();
  assert.equal(result.exitCode, 1);
  assert.equal(result.summary.outcome, "incomplete");
  assert.deepEqual(
    result.summary.tickets?.map(({ ticket, kind, status, pullRequest }) => ({
      ticket,
      kind,
      status,
      pullRequest,
    })),
    [{ ticket: 50, kind: "delivery", status: "PR ready", pullRequest: 81 }],
  );
  assert.ok(
    result.summary.tickets[0]!.retainedWorktrees.includes(
      (await fixture.snapshot()).worktree,
    ),
  );
  assert.ok(
    fixture.dependencies.messages.some((message) =>
      /Issue #50.*PR ready.*#81/u.test(message),
    ),
  );
  assert.equal(fixture.state.ticket.state, "open");
});

await test("releasing a Reservation after the handoff does not report successful delivery", async (t) => {
  const fixture = await implementationRun(t);
  fixture.state.onClose = async () => {
    fixture.state.ticket.assignees = [];
    fixture.state.ticket.labels = ["ready-for-agent"];
  };
  const result = await fixture.run();
  assert.equal(result.summary.outcome, "incomplete");
  assert.equal(result.exitCode, 1);
  assert.equal(result.summary.tickets?.[0]?.status, "incomplete");
  assert.equal(result.summary.tickets?.[0]?.pullRequest, null);
  assert.equal(fixture.state.ticket.state, "open");
});

await test("an ordinary no_change handoff reports no delivery credit", async (t) => {
  const fixture = await implementationRun(t);
  fixture.state.onTask = async (file) => {
    fixture.state.evidence.changed = false;
    await publish(file, {
      outcome: "no_change",
      summary: "No change needed.",
      commits: [],
      findings_file: null,
    });
  };
  const result = await fixture.run();
  assert.equal(result.summary.outcome, "incomplete");
  assert.equal((await fixture.snapshot()).phase, "implementation_completed");
  assert.match(
    result.summary.reasons.join(" "),
    /no_change.*no Issue delivery/,
  );
  assert.equal(result.exitCode, 1);
  assert.equal(result.summary.tickets?.[0]?.status, "no_change");
  assert.equal(result.summary.tickets?.[0]?.pullRequest, null);
  assert.equal(fixture.state.ticket.state, "open");
});

await test("progress identifies pending Probes, native identity, and each current absolute correction path", async (t) => {
  const fixture = await implementationRun(t);
  const probe = fixture.state.onProbe;
  fixture.state.onProbe = async (assignment) => {
    assert.ok(
      fixture.dependencies.messages.includes(
        `Issue #50 implement sessionid=pending handoff=${String(assignment.path)}`,
      ),
    );
    await probe(assignment);
  };
  let original = "";
  fixture.state.onTask = async (file) => {
    original = file;
    assert.ok(
      fixture.dependencies.messages.includes(
        `Issue #50 implement sessionid=native/$&/$\u0060/$'/session handoff=${file}`,
      ),
    );
    fixture.state.evidence.commits = committed().commits;
    await writeFile(file, "{");
  };
  fixture.state.onCorrection = async (file) => {
    assert.notEqual(file, original);
    assert.ok(
      fixture.dependencies.messages.includes(
        `Issue #50 implement sessionid=native/$&/$\u0060/$'/session handoff=${file}`,
      ),
    );
    await publish(file, committed());
  };
  assert.equal((await fixture.run()).summary.outcome, "incomplete");
  assert.deepEqual((await fixture.snapshot()).superseded, [original]);
});

await test("cancelling the final audit write retains completed ticket evidence without replaying delivery", async (t) => {
  const fixture = await integrationRun(t);
  const write = fixture.dependencies.operator.write.bind(
    fixture.dependencies.operator,
  );
  fixture.dependencies.operator.write = (message) => {
    write(message);
    if (!message.startsWith("Issue #50 delivery: completed")) return;
    const logs = path.join(fixture.directory, "logs");
    const [file] = readdirSync(logs);
    const audit = path.join(logs, file!);
    renameSync(audit, `${audit}.saved`);
    mkdirSync(audit);
  };
  fixture.dependencies.operator.pause = async (message) => {
    assert.match(message, /Audit write failed/u);
    return "q";
  };
  const result = await fixture.run();
  assert.equal(result.summary.outcome, "cancelled");
  assert.equal(result.exitCode, 1);
  assert.equal(result.summary.tickets?.[0]?.status, "completed");
  assert.equal(fixture.integrationState.requests.length, 1);
  assert.equal(fixture.integrationState.closures, 1);
});
