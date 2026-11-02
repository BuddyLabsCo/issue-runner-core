/* eslint-disable @typescript-eslint/require-await -- Scripted external boundaries. */
import { promptAssignment } from "../support/prompt-assignment.ts";
import assert from "node:assert/strict";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
} from "node:fs";
import { readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import {
  committed,
  deferred,
  implementationRun,
  publish,
} from "../support/implementation-run.ts";
import { child, parentDeliveryRun, parentRun } from "../support/parent-run.ts";
import { integrationRun } from "../support/integration-run.ts";
import { documentationRun } from "../support/documentation-run.ts";

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
  const report = fixture.dependencies.messages.at(-1)!;
  assert.match(report, /^Issue\s+Status\s+PR\s+Detail$/mu);
  assert.match(report, /^51\s+completed\s+/mu);
  assert.match(report, /^52\s+completed\s+/mu);
  assert.ok(report.indexOf("51  ") < report.indexOf("52  "));
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
    const output = fixture.dependencies.messages.at(-1)!;
    assert.match(output, new RegExp(`^50\\s+${outcome}\\s+-\\s+`, "mu"));
    assert.match(output, /^Retained Worktrees:$/mu);
    assert.match(output, /^Retained recovery evidence:$/mu);
    assert.ok(output.includes(saved.invocation!.path));
    assert.ok(output.includes(`Recorded branches (historical references):`));
    assert.match(
      output,
      outcome === "cancelled" ? /^Run cancelled\.$/mu : /^Run failed:$/mu,
    );
    assert.equal(
      fixture.dependencies.messages.filter((message) =>
        message.startsWith("Run failed:"),
      ).length,
      0,
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
      /^50\s+PR ready\s+/mu.test(message),
    ),
  );
  const output = fixture.dependencies.messages.at(-1)!;
  const worktree = (await fixture.snapshot()).worktree;
  assert.match(output, /CI-ready, awaiting manual merge/u);
  assert.ok(!output.split("\n\n")[0]!.includes(worktree));
  assert.equal(output.split(worktree).length - 1, 1);
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
  const now = fixture.dependencies.clock.now.bind(fixture.dependencies.clock);
  let disrupted = false;
  fixture.dependencies.clock.now = () => {
    const logs = path.join(fixture.directory, "logs");
    const [file] = existsSync(logs) ? readdirSync(logs) : [];
    if (file && !disrupted) {
      const audit = path.join(logs, file);
      // The last cleanup success is followed by its checkpoint's two audit records.
      const last = readFileSync(audit, "utf8").trim().split("\n").at(-3);
      const event = last
        ? (JSON.parse(last) as {
            operation: string;
            result: string;
            target: string;
          })
        : undefined;
      if (
        event?.operation === "cleanup_handoff" &&
        event.result === "succeeded" &&
        event.target.endsWith(".json.tmp") &&
        readdirSync(path.join(fixture.directory, "handoffs")).length === 0
      ) {
        disrupted = true;
        renameSync(audit, `${audit}.saved`);
        mkdirSync(audit);
      }
    }
    return now();
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

await test("five completed Issues print one aligned report with visible PR links", async (t) => {
  const fixture = await parentDeliveryRun(
    t,
    [55, 54, 53, 52, 51].map((number) => child(number)),
  );
  const host = fixture.dependencies.codeHost;
  const list = host.listPullRequests.bind(host);
  const create = host.createPullRequest.bind(host);
  const numbers = new Map([
    [81, 1],
    [82, 22],
    [83, 333],
    [84, 4444],
    [85, 55555],
  ]);
  host.listPullRequests = async () =>
    (await list()).map((pr) => ({
      ...pr,
      number: numbers.get(pr.number)!,
      url: `https://github.com/owner/repo/pull/${numbers.get(pr.number)!}`,
    }));
  host.createPullRequest = async (input) => {
    const pr = await create(input);
    return {
      number: numbers.get(pr.number)!,
      url: `https://github.com/owner/repo/pull/${numbers.get(pr.number)!}`,
    };
  };
  const result = await fixture.run();
  assert.equal(result.exitCode, 0);
  const output = fixture.dependencies.messages.at(-1)!;
  // eslint-disable-next-line no-control-regex -- Verify visible OSC 8 text and alignment.
  const plain = output.replace(/\u001b\]8;;[^\u001b]*\u001b\\/gu, "");
  assert.match(plain, /^Issue\s+Status\s+PR\s+Detail$/mu);
  const rows = plain.split("\n").filter((line) => /^5[1-5]\s/u.test(line));
  assert.deepEqual(
    rows.map((row) => Number(row.trim().split(/\s/u)[0])),
    [51, 52, 53, 54, 55],
  );
  assert.ok(
    rows.every((row) => row.endsWith("Squash merged and Issue closed")),
  );
  assert.ok(rows.every((row) => row.length < 80));
  assert.ok(
    rows.every((row) => row.indexOf("Squash") === rows[0]!.indexOf("Squash")),
  );
  assert.deepEqual(rows.map((row) => /#\d+/u.exec(row)![0]).sort(), [
    "#1",
    "#22",
    "#333",
    "#4444",
    "#55555",
  ]);
  assert.match(output, /https:\/\/github\.com\/owner\/repo\/pull\//u);
  assert.doesNotMatch(
    plain,
    /selected Delivery Tickets|;|targetBranch=|delivery: completed/u,
  );
  assert.equal(
    fixture.dependencies.messages.filter((message) =>
      message.startsWith("Issue  "),
    ).length,
    1,
  );
});

await test("an empty Run renders the reference no-work message", async (t) => {
  const fixture = await parentRun(t, []);
  const result = await fixture.run();
  assert.equal(result.summary.outcome, "no_work");
  assert.equal(result.exitCode, 0);
  assert.equal(fixture.dependencies.messages.at(-1), "No issues processed.");
});

await test("actionable selection reasons stay separate from completed rows", async (t) => {
  const fixture = await parentDeliveryRun(t, [child(51), child(52)]);
  fixture.dependencies.tracker.listBlockersPage = async (
    _repository,
    number,
  ) => ({
    blockers: number === 52 ? [child(99)] : [],
    nextPage: null,
  });
  const result = await fixture.run();
  assert.equal(result.summary.outcome, "incomplete");
  assert.equal(result.exitCode, 1);
  const output = fixture.dependencies.messages.at(-1)!;
  assert.match(output, /^51\s+completed\s+/mu);
  assert.match(output, /^Reasons:\n- blocked Delivery Tickets: 52$/mu);
  assert.doesNotMatch(output, /selected Delivery Tickets|Issue #51: Issue/u);
});

await test("completed cleanup labels surviving checkpoints as evidence, not live Worktrees", async (t) => {
  const fixture = await integrationRun(t);
  fixture.dependencies.gitWorkspace.cleanupWorktree = async ({ worktree }) =>
    rm(worktree, { recursive: true });
  const result = await fixture.run();
  assert.equal(result.exitCode, 0);
  assert.deepEqual(result.summary.tickets?.[0]?.retainedWorktrees, []);
  const saved = await fixture.snapshot();
  const output = fixture.dependencies.messages.at(-1)!;
  assert.doesNotMatch(output, /Retained Worktrees:|selected Delivery Tickets/u);
  assert.match(output, /^Retained recovery evidence:$/mu);
  assert.match(output, /^Recorded branches \(historical references\):$/mu);
  assert.ok(output.includes(saved.branch));
  assert.ok(output.includes(path.join(fixture.directory, "recovery")));
  assert.ok(!output.includes(saved.worktree));
});

await test("documentation no_change renders a labelled maintenance row", async (t) => {
  const fixture = await documentationRun(t);
  fixture.state.onTask = async (file) => {
    fixture.state.evidence.changed = false;
    await publish(file, {
      outcome: "no_change",
      summary: "Docs are current.",
      commits: [],
      findings_file: null,
    });
  };
  const result = await fixture.run();
  assert.equal(result.exitCode, 0);
  assert.equal(result.summary.outcome, "succeeded");
  assert.match(
    fixture.dependencies.messages.at(-1)!,
    /^50\s+no_change\s+-\s+Documentation: Completed Maintenance Ticket 50 with no changes$/mu,
  );
});

await test("cancellation before ticket dispatch reports why the Run stopped", async (t) => {
  const fixture = await parentRun(t, []);
  fixture.dependencies.tracker.getParent = async () =>
    child(48, { state: "closed", stateReason: "not_planned" });
  const result = await fixture.run();
  assert.equal(result.exitCode, 1);
  assert.equal(result.summary.outcome, "cancelled");
  assert.equal(result.summary.failure, "Parent Ticket is cancelled");
  assert.ok(result.summary.reasons.includes("Parent Ticket is cancelled"));
  assert.deepEqual(result.summary.tickets, []);
  assert.deepEqual(fixture.dispatched, []);
  assert.equal(
    fixture.dependencies.messages.at(-1),
    "No issues processed.\n\nReasons:\n- Parent Ticket is cancelled\n\nRun cancelled.",
  );
});
