/* eslint-disable @typescript-eslint/require-await -- Scripted external boundaries. */
import assert from "node:assert/strict";
import test from "node:test";
import {
  mkdir,
  readFile,
  readdir,
  rename,
  rmdir,
  writeFile,
} from "node:fs/promises";
import path from "node:path";
import { implementationRun } from "../support/implementation-run.ts";
import { deferred } from "../support/implementation-run.ts";
import { child, parentRun } from "../support/parent-run.ts";
import { validConfig } from "../support/cli-project.ts";

for (const response of ["q", null]) {
  await test(`audit creation rejects skip and success claims before ${response ?? "EOF"} cancels without delivery effects`, async (t) => {
    const fixture = await implementationRun(t);
    await writeFile(
      path.join(fixture.directory, "logs"),
      "obstruct audit directory",
    );
    const responses = ["s", "claimed success", response];
    fixture.dependencies.operator.pause = async (message) => {
      fixture.dependencies.pauses.push(message);
      assert.match(message, /Audit write failed/);
      assert.doesNotMatch(message, /s to skip/);
      assert.ok(responses.length);
      return responses.shift()!;
    };
    const result = await fixture.run();
    assert.equal(result.summary.outcome, "cancelled");
    assert.equal(fixture.dependencies.pauses.length, 3);
    assert.deepEqual(fixture.state.events, []);
    assert.deepEqual(fixture.dependencies.reads, []);
    assert.equal(result.logPath, null);
  });
}

for (const operation of ["Git fetch", "Reservation write"] as const) {
  await test(`${operation} reuses the final seconds-based delay and requires Enter after exhausting additional retries`, async (t) => {
    const fixture = await implementationRun(t, {
      ...validConfig,
      operationRetry: 3,
      operationRetryDelay: [2, 5],
    });
    let attempts = 0;
    const fail = () => {
      if (++attempts <= 4) throw new Error("service unavailable");
    };
    if (operation === "Git fetch") {
      const fetch = fixture.dependencies.gitWorkspace.fetchTargetBranch.bind(
        fixture.dependencies.gitWorkspace,
      );
      fixture.dependencies.gitWorkspace.fetchTargetBranch = async () => {
        fail();
        return fetch();
      };
    } else {
      const assign = fixture.dependencies.tracker.addAssignee.bind(
        fixture.dependencies.tracker,
      );
      fixture.dependencies.tracker.addAssignee = async (...args) => {
        fail();
        await assign(...args);
      };
    }
    const responses = ["claimed success", ""];
    fixture.dependencies.operator.pause = async (message) => {
      fixture.dependencies.pauses.push(message);
      assert.match(message, /service unavailable/);
      assert.equal(attempts, 4);
      assert.deepEqual(fixture.state.sleeps, [2_000, 5_000, 5_000]);
      return responses.shift()!;
    };
    const result = await fixture.run();
    assert.equal(result.summary.outcome, "incomplete", JSON.stringify(result));
    assert.equal(attempts, 5);
    assert.equal(fixture.dependencies.pauses.length, 2);
    assert.equal(fixture.state.taskCount, 1);
  });
}

await test("a rejected substantive prompt is audited without replay, redirection, or Operator Pause", async (t) => {
  const fixture = await implementationRun(t);
  const submit = fixture.dependencies.terminalPlugin.submitText.bind(
    fixture.dependencies.terminalPlugin,
  );
  fixture.dependencies.terminalPlugin.submitText = async (tab, text, chord) => {
    await submit(tab, text, chord);
    if (text.startsWith("Implementation assignment\n"))
      throw new Error("submitText response lost after delivery");
  };
  const result = await fixture.run();
  assert.equal(result.summary.outcome, "failed");
  assert.equal(fixture.state.taskCount, 1);
  assert.equal(
    new Set(fixture.state.submissions.map((value) => value.tab)).size,
    1,
  );
  assert.deepEqual(fixture.dependencies.pauses, []);
  assert.equal((await fixture.snapshot()).result, undefined);
  assert.match(
    await readFile(result.logPath!, "utf8"),
    /submitText response lost after delivery/,
  );
});

for (const operation of ["createTab", "submitText", "closeTab"] as const) {
  await test(`cancelling unresolved ${operation} stops the Run without waiting for the I/O bound`, async (t) => {
    const fixture = await implementationRun(t);
    const entered = deferred<void>();
    const pending = deferred<never>();
    fixture.dependencies.terminalPlugin[operation] = () => {
      entered.resolve();
      return pending.promise;
    };
    const running = fixture.run();
    await entered.promise;
    fixture.controller.abort();
    const result = await running;
    assert.equal(result.summary.outcome, "cancelled");
    assert.deepEqual(fixture.dependencies.pauses, []);
    assert.equal(fixture.state.taskCount, operation === "closeTab" ? 1 : 0);
    pending.reject(new Error("late I/O rejection"));
  });
}

for (const effect of [
  "Reservation",
  "Worktree",
  "Runner Tab",
  "prompt",
  "close",
] as const) {
  await test(`audit recovery cannot replay a completed ${effect} or accept a logging gap`, async (t) => {
    const fixture = await implementationRun(t);
    let completed = 0;
    let auditFile = "";
    const blockAudit = async () => {
      ++completed;
      const [name] = await readdir(path.join(fixture.directory, "logs"));
      assert.ok(name);
      auditFile = path.join(fixture.directory, "logs", name);
      await rename(auditFile, `${auditFile}.saved`);
      await mkdir(auditFile);
    };
    if (effect === "Reservation") {
      const write = fixture.dependencies.tracker.addAssignee.bind(
        fixture.dependencies.tracker,
      );
      fixture.dependencies.tracker.addAssignee = async (...args) => {
        await write(...args);
        await blockAudit();
      };
    } else if (effect === "Worktree") {
      const create = fixture.dependencies.gitWorkspace.createWorktree.bind(
        fixture.dependencies.gitWorkspace,
      );
      fixture.dependencies.gitWorkspace.createWorktree = async (input) => {
        await create(input);
        await blockAudit();
      };
    } else if (effect === "Runner Tab") {
      const create = fixture.dependencies.terminalPlugin.createTab.bind(
        fixture.dependencies.terminalPlugin,
      );
      fixture.dependencies.terminalPlugin.createTab = async (options) => {
        const tab = await create(options);
        await blockAudit();
        return tab;
      };
    } else if (effect === "prompt") {
      const task = fixture.state.onTask;
      fixture.state.onTask = async (file) => {
        await task(file);
        await blockAudit();
      };
    } else fixture.state.onClose = blockAudit;
    const responses = ["s", "accept gap", ""];
    fixture.dependencies.operator.pause = async (message) => {
      fixture.dependencies.pauses.push(message);
      assert.match(message, /Audit write failed/);
      assert.doesNotMatch(message, /s to skip/);
      const response = responses.shift();
      assert.notEqual(response, undefined);
      if (response === "") {
        await rmdir(auditFile);
        await rename(`${auditFile}.saved`, auditFile);
      }
      return response!;
    };
    const result = await fixture.run();
    assert.equal(result.summary.outcome, "incomplete", JSON.stringify(result));
    assert.equal(completed, 1);
    assert.equal(fixture.dependencies.pauses.length, 3);
    assert.equal(fixture.state.taskCount, 1);
    assert.equal(fixture.state.closedTabs.length, 1);
    const audit = await readFile(result.logPath!, "utf8");
    assert.doesNotMatch(
      audit,
      /tracker-secret|host-secret|Implementation assignment/,
    );
  });
}

for (const operation of ["addLabel", "addAssignee"] as const) {
  await test(`a lost ${operation} response is reconciled immediately even with no automatic retries`, async (t) => {
    const fixture = await implementationRun(t, {
      ...validConfig,
      operationRetry: 0,
    });
    const write = fixture.dependencies.tracker[operation].bind(
      fixture.dependencies.tracker,
    );
    let mutations = 0;
    fixture.dependencies.tracker[operation] = async (repo, number, value) => {
      ++mutations;
      await write(repo, number, value);
      throw new Error("response lost after mutation");
    };
    const result = await fixture.run();
    assert.equal(result.summary.outcome, "incomplete", JSON.stringify(result));
    assert.equal(mutations, 1);
    assert.deepEqual(fixture.dependencies.pauses, []);
    assert.deepEqual(fixture.state.sleeps, [10_000, 30_000]);
    assert.equal(fixture.state.taskCount, 1);
  });
}

for (const operation of ["createTab", "submitText", "closeTab"] as const) {
  await test(`an unresolved terminal ${operation} has a finite bound and retains partial-operation diagnostics`, async (t) => {
    const fixture = await implementationRun(t, {
      ...validConfig,
      operationRetry: 0,
    });
    const entered = deferred<void>();
    let calls = 0;
    fixture.dependencies.terminalPlugin[operation] = () => {
      ++calls;
      entered.resolve();
      return new Promise<never>(() => {
        /* The transport never acknowledges completion. */
      });
    };
    fixture.dependencies.operator.pause = async (message) => {
      fixture.dependencies.pauses.push(message);
      assert.match(message, /timed out.*partial/);
      return "q";
    };
    t.mock.timers.enable({ apis: ["setTimeout"] });
    const running = fixture.run();
    await entered.promise;
    t.mock.timers.tick(60_000);
    const result = await running;
    assert.equal(
      result.summary.outcome,
      operation === "submitText" ? "failed" : "cancelled",
      JSON.stringify(result),
    );
    assert.equal(calls, 1);
    assert.equal(
      fixture.dependencies.pauses.length,
      operation === "submitText" ? 0 : 1,
    );
    assert.equal(fixture.state.taskCount, operation === "closeTab" ? 1 : 0);
    if (operation === "closeTab")
      assert.equal(
        (await fixture.snapshot()).phase,
        "implementation_completed",
      );
    const audit = await readFile(result.logPath!, "utf8");
    assert.match(audit, /timed out after 60000ms; operation may be partial/);
    if (operation === "closeTab") assert.match(audit, /cleanup is unresolved/);
  });
}

await test("failed tab creation pauses before an explicitly authorized new resource attempt", async (t) => {
  const fixture = await implementationRun(t);
  const create = fixture.dependencies.terminalPlugin.createTab.bind(
    fixture.dependencies.terminalPlugin,
  );
  let attempts = 0;
  fixture.dependencies.terminalPlugin.createTab = async (options) => {
    if (++attempts === 1)
      throw new Error("createTab response lost; tab may exist");
    return create(options);
  };
  fixture.dependencies.operator.pause = async (message) => {
    fixture.dependencies.pauses.push(message);
    assert.match(message, /createTab response lost/);
    assert.equal(attempts, 1);
    assert.equal(fixture.state.submissions.length, 0);
    return "";
  };
  const result = await fixture.run();
  assert.equal(result.summary.outcome, "incomplete", JSON.stringify(result));
  assert.equal(attempts, 2);
  assert.equal(fixture.dependencies.pauses.length, 1);
  assert.equal(fixture.state.taskCount, 1);
});

await test("skipping a non-Agent Issue failure retains its Reservation and lets its sibling finish", async (t) => {
  const fixture = await parentRun(t, [child(51), child(52)], {
    ...validConfig,
    operationRetry: 0,
  });
  const assign = fixture.dependencies.tracker.addAssignee.bind(
    fixture.dependencies.tracker,
  );
  fixture.dependencies.tracker.addAssignee = async (repo, number, account) => {
    if (number === 51) throw new Error("assignment unavailable");
    await assign(repo, number, account);
  };
  let pauses = 0;
  fixture.dependencies.operator.pause = async (message) => {
    assert.match(message, /s to skip Issue #51/);
    assert.match(message, /assignment unavailable/);
    ++pauses;
    return "s";
  };
  const result = await fixture.run();
  assert.equal(result.summary.outcome, "incomplete", JSON.stringify(result));
  assert.equal(pauses, 1);
  assert.deepEqual(fixture.dispatched, [52]);
  assert.ok(fixture.writes.includes("label:51"));
  assert.match(
    result.summary.reasons.join("; "),
    /skipped Issue #51; side effects may remain/,
  );
});

await test("Worktree creation requires manual retry without spending the automatic budget", async (t) => {
  const fixture = await implementationRun(t);
  const create = fixture.dependencies.gitWorkspace.createWorktree.bind(
    fixture.dependencies.gitWorkspace,
  );
  let attempts = 0;
  fixture.dependencies.gitWorkspace.createWorktree = async (input) => {
    if (++attempts === 1)
      throw new Error("Worktree creation failed; partial resources may remain");
    await create(input);
  };
  fixture.dependencies.operator.pause = async (message) => {
    fixture.dependencies.pauses.push(message);
    assert.match(message, /Worktree creation failed/);
    assert.equal(attempts, 1);
    assert.deepEqual(fixture.state.sleeps, []);
    return "";
  };
  const result = await fixture.run();
  assert.equal(result.summary.outcome, "incomplete", JSON.stringify(result));
  assert.equal(attempts, 2);
  assert.equal(fixture.dependencies.pauses.length, 1);
  assert.equal(fixture.state.taskCount, 1);
});
