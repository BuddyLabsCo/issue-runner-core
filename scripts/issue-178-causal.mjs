/* eslint-disable -- Temporary causal diagnostic; never merge. */
// @ts-nocheck
import assert from "node:assert/strict";
import { readFile, writeFile } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import path from "node:path";

const batchFile = "tests/run/cli-batch.test.ts";
const cancelFile = "tests/run/cli-cancellation.test.ts";
const batch = await readFile(batchFile, "utf8");
const cancellation = await readFile(cancelFile, "utf8");
const qStart = cancellation.indexOf('await test("q in a sibling');
const qEnd = cancellation.indexOf(
  '\nfor (const boundary of ["Probe", "handoff"]',
  qStart,
);
assert.ok(qStart >= 0 && qEnd > qStart);
const qBody = cancellation.slice(qStart, qEnd);
const injections = [
  {
    name: "batch-setup",
    file: batchFile,
    pattern: "^issue executes a bounded Batch concurrently",
    deadline: "batch-deadline",
    error: "second Issue did not run concurrently",
    source: batch.replace(
      "    const gates = new Map",
      `    const diagnosticGetTicket = fixture.dependencies.tracker.getTicket;
    let diagnosticDelayed = false;
    fixture.dependencies.tracker.getTicket = async (...args) => {
      if (!diagnosticDelayed) {
        diagnosticDelayed = true;
        await new Promise((resolve) => setTimeout(resolve, 3300));
      }
      return diagnosticGetTicket(...args);
    };
    const gates = new Map`,
    ),
  },
  {
    name: "cancel-setup",
    file: cancelFile,
    pattern: "q in a sibling",
    deadline: "cancel-deadline",
    error: "Batch still waits for sibling startup",
    injection: `  const diagnosticFetch = fixture.dependencies.gitWorkspace.fetchTargetBranch;
  fixture.dependencies.gitWorkspace.fetchTargetBranch = async (...args) => {
    await new Promise((resolve) => setTimeout(resolve, 1200));
    return diagnosticFetch(...args);
  };
`,
  },
  {
    name: "cancel-cleanup",
    file: cancelFile,
    pattern: "q in a sibling",
    deadline: "cancel-deadline",
    error: "Batch still waits for sibling startup",
    injection: `  const diagnosticEnvironment = fixture.dependencies.gitWorkspace.withAgentEnvironment;
  fixture.dependencies.gitWorkspace.withAgentEnvironment = (directory, action) =>
    diagnosticEnvironment(directory, async (env) => {
      try {
        return await action(env);
      } finally {
        EventEmitter.prototype.emit.call(process, "issue178", "post-abort-cleanup-start");
        await new Promise((resolve) => setTimeout(resolve, 1200));
        EventEmitter.prototype.emit.call(process, "issue178", "post-abort-cleanup-end");
      }
    });
`,
  },
];
try {
  for (const scenario of injections) {
    const source =
      scenario.source ??
      cancellation.slice(0, qStart) +
        qBody.replace(
          "  const entered = deferred<void>();",
          scenario.injection + "  const entered = deferred<void>();",
        ) +
        cancellation.slice(qEnd);
    assert.notEqual(source, scenario.file === batchFile ? batch : cancellation);
    await writeFile(scenario.file, source);
    for (const observe of ["0", "1"]) {
      console.log(
        "[I178-CAUSAL]",
        JSON.stringify({ scenario: scenario.name, observe }),
      );
      const child = spawnSync(
        process.execPath,
        ["--test", `--test-name-pattern=${scenario.pattern}`, scenario.file],
        {
          encoding: "utf8",
          env: {
            ...process.env,
            I178_OBSERVE: observe,
            I178_CASE: scenario.name,
            I178_TRACE_DIR: path.join(
              process.env.I178_TRACE_DIR,
              `${scenario.name}-${observe}`,
            ),
          },
        },
      );
      process.stdout.write(child.stdout ?? "");
      process.stderr.write(child.stderr ?? "");
      assert.equal(child.status, observe === "0" ? 1 : 0);
      assert.ok(child.stdout.includes(scenario.deadline));
      if (observe === "0") assert.ok(child.stdout.includes(scenario.error));
      console.log(
        "[I178-CAUSAL-VERIFIED]",
        JSON.stringify({
          scenario: scenario.name,
          observe,
          status: child.status,
        }),
      );
    }
    await writeFile(
      scenario.file,
      scenario.file === batchFile ? batch : cancellation,
    );
  }
} finally {
  await writeFile(batchFile, batch);
  await writeFile(cancelFile, cancellation);
}
