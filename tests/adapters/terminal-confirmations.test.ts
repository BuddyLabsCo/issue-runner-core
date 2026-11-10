import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { getEventListeners, once } from "node:events";
import test from "node:test";
import { TerminalConfirmations } from "../../src/run/confirmations.ts";
import { deferred } from "../support/implementation-run.ts";

await test("terminal confirmations retain FIFO order and the active request on unsupported input", async () => {
  const answers = [deferred<string>(), deferred<string>(), deferred<string>()];
  const prompts: string[] = [];
  const messages: string[] = [];
  let readers = 0;
  const queue = new TerminalConfirmations(
    {
      write: (message) => messages.push(message),
      async pause(message) {
        assert.equal(++readers, 1);
        const answer = answers[prompts.length]!;
        prompts.push(message);
        try {
          return await answer.promise;
        } finally {
          readers--;
        }
      },
    },
    new AbortController().signal,
  );
  const first = queue.request({
    id: "first",
    message: "First confirmation",
    accepts: (response) => response === "",
  });
  const second = queue.request({
    id: "second",
    message: "Second confirmation",
    accepts: (response) => response === "",
  });
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.deepEqual(queue.status, {
    active: { id: "first", message: "First confirmation" },
    pending: [{ id: "second", message: "Second confirmation" }],
  });
  answers[0]!.resolve("q");
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.deepEqual(prompts, ["First confirmation", "First confirmation"]);
  assert.deepEqual(messages, ["Unsupported input."]);
  answers[1]!.resolve("");
  assert.equal(await first, "");
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.deepEqual(prompts, [
    "First confirmation",
    "First confirmation",
    "Second confirmation",
  ]);
  answers[2]!.resolve("");
  assert.equal(await second, "");
  assert.deepEqual(queue.status, { active: undefined, pending: [] });
});

await test("cancelling queued and active confirmations advances without Enter or retained listeners", async () => {
  const run = new AbortController();
  const active = new AbortController();
  const queued = new AbortController();
  const displayed: string[] = [];
  const readerSignals: AbortSignal[] = [];
  const answer = deferred<string>();
  const nextDisplayed = deferred<void>();
  let readers = 0;
  const queue = new TerminalConfirmations(
    {
      write: () => assert.fail("cancellation is not unsupported input"),
      async pause(message, signal) {
        assert.ok(signal);
        assert.equal(++readers, 1);
        readerSignals.push(signal);
        displayed.push(message);
        let abort!: () => void;
        const cancelled = new Promise<never>((_resolve, reject) => {
          abort = () => reject(new Error("input cancelled"));
          signal.addEventListener("abort", abort, { once: true });
        });
        if (message === "Next") nextDisplayed.resolve();
        try {
          return await Promise.race([answer.promise, cancelled]);
        } finally {
          signal.removeEventListener("abort", abort);
          readers--;
        }
      },
    },
    run.signal,
  );
  const first = queue.request({
    id: "active",
    message: "Active",
    accepts: () => true,
    signal: active.signal,
  });
  const removed = queue.request({
    id: "queued",
    message: "Never displayed",
    accepts: () => true,
    signal: queued.signal,
  });
  const next = queue.request({
    id: "next",
    message: "Next",
    accepts: () => true,
  });
  await new Promise<void>((resolve) => setImmediate(resolve));
  const queuedCancelled = assert.rejects(removed, /queued ended/);
  queued.abort(new Error("queued ended"));
  await queuedCancelled;
  await assert.rejects(
    queue.request({
      id: "already-cancelled",
      message: "Never admitted",
      accepts: () => true,
      signal: queued.signal,
    }),
    /queued ended/,
  );
  assert.deepEqual(queue.status.pending, [{ id: "next", message: "Next" }]);
  const activeCancelled = assert.rejects(first, /active ended/);
  active.abort(new Error("active ended"));
  await activeCancelled;
  await nextDisplayed.promise;
  assert.deepEqual(displayed, ["Active", "Next"]);
  answer.resolve("");
  assert.equal(await next, "");
  assert.equal(run.signal.aborted, false);
  for (const signal of [...readerSignals, run.signal])
    assert.deepEqual(getEventListeners(signal, "abort"), []);
  assert.equal(readers, 0);
  assert.deepEqual(queue.status, { active: undefined, pending: [] });
});

await test("Run cancellation rejects active and queued waits even when input never settles", async () => {
  const run = new AbortController();
  const prompts: string[] = [];
  const queue = new TerminalConfirmations(
    {
      write: () => assert.fail("unexpected output"),
      pause(message) {
        prompts.push(message);
        return new Promise(() => {
          // Deliberately uncooperative input must not retain the Run.
        });
      },
    },
    run.signal,
  );
  const first = queue.request({
    id: "active",
    message: "Active",
    accepts: () => true,
  });
  const second = queue.request({
    id: "queued",
    message: "Queued",
    accepts: () => true,
  });
  await new Promise<void>((resolve) => setImmediate(resolve));
  const cancelled = Promise.all([
    assert.rejects(first, /Run ended/),
    assert.rejects(second, /Run ended/),
  ]);
  run.abort(new Error("Run ended"));
  await cancelled;
  await assert.rejects(
    queue.request({ id: "late", message: "Late", accepts: () => true }),
    /Run ended/,
  );
  assert.deepEqual(prompts, ["Active"]);
  assert.deepEqual(queue.status, { active: undefined, pending: [] });
  assert.deepEqual(getEventListeners(run.signal, "abort"), []);
});

await test("input failure and EOF release confirmation input without imposing Run cancellation", async () => {
  const run = new AbortController();
  const responses = [
    () => Promise.reject(new Error("input failed")),
    () => Promise.resolve(null),
    () => Promise.resolve(""),
  ];
  const prompts: string[] = [];
  const queue = new TerminalConfirmations(
    {
      write: () => assert.fail("unexpected output"),
      pause(message) {
        prompts.push(message);
        return responses.shift()!();
      },
    },
    run.signal,
  );
  const failed = assert.rejects(
    queue.request({ id: "failed", message: "Failed", accepts: () => true }),
    /input failed/,
  );
  const eof = queue.request({
    id: "eof",
    message: "EOF",
    accepts: (response) => response === "",
  });
  const enter = queue.request({
    id: "enter",
    message: "Enter",
    accepts: (response) => response === "",
  });
  await failed;
  assert.equal(await eof, null);
  assert.equal(await enter, "");
  assert.deepEqual(prompts, ["Failed", "EOF", "Enter"]);
  assert.equal(run.signal.aborted, false);
  assert.deepEqual(getEventListeners(run.signal, "abort"), []);
});

await test(
  "local cancellation closes real readline before the next request opens its reader",
  { timeout: 10_000 },
  async (t) => {
    const child = spawn(
      process.execPath,
      [
        "--input-type=module",
        "--eval",
        `
        import assert from "node:assert/strict";
        import { TerminalConfirmations } from ${JSON.stringify(new URL("../../src/run/confirmations.ts", import.meta.url).href)};
        import { TerminalOperator } from ${JSON.stringify(new URL("../../src/adapters/terminal.ts", import.meta.url).href)};
        class ObservedOperator extends TerminalOperator {
          pause(message, signal) {
            const waiting = super.pause(message, signal);
            assert.equal(process.stdin.listenerCount("data"), 1, "only one readline may be active");
            console.log("READING " + message);
            return waiting;
          }
        }
        const run = new AbortController();
        const active = new AbortController();
        const queued = new AbortController();
        const queue = new TerminalConfirmations(new ObservedOperator(), run.signal);
        const first = queue.request({ id: "first", message: "First", accepts: () => true, signal: active.signal });
        const firstCancelled = assert.rejects(first, /active ended/);
        const second = queue.request({ id: "second", message: "Never displayed", accepts: () => true, signal: queued.signal });
        const secondCancelled = assert.rejects(second, /queued ended/);
        const final = queue.request({ id: "final", message: "Final", accepts: (response) => response === "" });
        queued.abort(new Error("queued ended"));
        setImmediate(() => active.abort(new Error("active ended")));
        await Promise.all([firstCancelled, secondCancelled]);
        assert.equal(await final, "");
        assert.equal(run.signal.aborted, false);
        assert.equal(process.stdin.listenerCount("data"), 0, "readline must release stdin");
        console.log("COMPLETED");
        `,
      ],
      { signal: t.signal },
    );
    let stdout = "";
    let stderr = "";
    let answered = false;
    child.stdout.setEncoding("utf8").on("data", (text: string) => {
      stdout += text;
      if (!answered && stdout.includes("READING Final")) {
        answered = true;
        child.stdin.write("\n");
      }
    });
    child.stderr.setEncoding("utf8").on("data", (text: string) => {
      stderr += text;
    });
    const result: unknown[] = await once(child, "close");
    const [code] = result;
    assert.equal(code, 0, `${stdout}\n${stderr}`);
    assert.match(stdout, /READING First[\s\S]*READING Final[\s\S]*COMPLETED/u);
    assert.doesNotMatch(stdout, /Never displayed/u);
  },
);
