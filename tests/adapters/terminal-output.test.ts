import assert from "node:assert/strict";
import { PassThrough } from "node:stream";
import test from "node:test";
import { TerminalOperator } from "../../src/adapters/terminal.ts";
import { TerminalConfirmations } from "../../src/run/confirmations.ts";

const tick = () => new Promise<void>((resolve) => setImmediate(resolve));

function terminalHarness(tty = true) {
  const input = new PassThrough();
  const output = Object.assign(new PassThrough(), { isTTY: tty, columns: 80 });
  let printed = "";
  output.setEncoding("utf8").on("data", (text: string) => {
    printed += text;
  });
  const operator = new TerminalOperator(undefined, { input, output });
  const run = new AbortController();
  const queue = new TerminalConfirmations(operator, run.signal);
  return { input, operator, run, queue, output: () => printed };
}

await test("Core output redraws the active task and pending count without replacing readline or partial input", async (t) => {
  const terminal = terminalHarness();
  t.after(() => {
    terminal.run.abort();
    terminal.input.destroy();
  });
  const { input, queue, operator } = terminal;
  const first = queue.request({
    id: "operator",
    message: "[Operator Pause] Issue #351 implement: choose Enter, s or q",
    accepts: (response) => ["", "s", "q"].includes(response),
  });
  await tick();
  const second = queue.request({
    id: "enhancement",
    message: "[Enhancement Pause] Issue #352 review: attention needed",
    accepts: (response) => response === "",
  });
  await tick();
  input.write("sq\u001b[D");
  const before = terminal.output().length;
  operator.write("Issue #353 completed\r\nMore progress");
  operator.write("Still working");
  const redrawn = terminal.output().slice(before);
  assert.match(redrawn, /Issue #353 completed\r?\nMore progress/u);
  assert.match(
    redrawn,
    /Still working[\s\S]*Issue #351 implement[\s\S]*1 pending/u,
  );
  assert.doesNotMatch(redrawn, /Issue #352 review/u);
  assert.equal(input.listenerCount("keypress"), 1);
  assert.equal(queue.status.active?.id, "operator");
  // Delete q at the preserved cursor, leaving the supported Operator Pause response s.
  input.write("\u001b[3~\r");
  assert.equal(await first, "s");
  await tick();
  assert.match(terminal.output(), /Issue #352 review/u);
  const enhancementOutput = terminal.output().length;
  operator.write("Progress during Enhancement Pause");
  assert.match(
    terminal.output().slice(enhancementOutput),
    /Progress during Enhancement Pause[\s\S]*Issue #352 review/u,
  );
  assert.doesNotMatch(
    terminal.output().slice(enhancementOutput),
    /Issue #351 implement|pending/u,
  );
  input.write("\r");
  assert.equal(await second, "");
  assert.equal(input.listenerCount("keypress"), 0);
  const ended = terminal.output().length;
  operator.write("All done");
  assert.equal(terminal.output().slice(ended), "All done\n");
  input.destroy();
});

for (const tty of [false, true]) {
  for (const newline of ["\n", "\r\n"]) {
    await test(`buffered ${JSON.stringify(newline)} cannot acknowledge queued or reentrant confirmations (TTY=${tty})`, async (t) => {
      const { input, queue, run, operator, output } = terminalHarness(tty);
      t.after(() => {
        run.abort();
        input.destroy();
      });
      const answers: string[] = [];
      const request = (id: string) =>
        queue
          .request({
            id,
            message: id,
            accepts: (response) => response === "",
          })
          .then((response) => {
            assert.equal(response, "");
            answers.push(id);
          });
      const first = request("first").then(() => request("reentrant"));
      const second = request("second");
      await tick();
      input.write(newline.repeat(3));
      await tick();
      assert.deepEqual(answers, ["first"]);
      assert.equal(queue.status.active?.id, "second");
      operator.write("Progress during second");
      assert.match(
        output(),
        /Progress during second[\s\S]*second[\s\S]*1 pending/u,
      );
      input.write(`q${newline}${newline}`);
      await tick();
      assert.deepEqual(answers, ["first"]);
      assert.equal(queue.status.active?.id, "second");
      assert.match(output(), /Unsupported input/u);
      input.write(newline);
      await second;
      await tick();
      assert.deepEqual(answers, ["first", "second"]);
      assert.equal(queue.status.active?.id, "reentrant");
      input.write(newline);
      await first;
      assert.deepEqual(answers, ["first", "second", "reentrant"]);
    });
  }
}

for (const tty of [false, true]) {
  await test(`cancellation preserves ended output and EOF releases queued waits without acknowledgment (TTY=${tty})`, async (t) => {
    const { input, queue, operator, run, output } = terminalHarness(tty);
    t.after(() => {
      run.abort();
      input.destroy();
    });
    const active = new AbortController();
    // The lifecycle owner prints the reason synchronously when it invalidates a request.
    active.signal.addEventListener("abort", () => {
      operator.write(
        "[Enhancement Pause ended] Issue #351 implement: completed",
      );
      operator.write("Completion recorded");
    });
    const first = queue.request({
      id: "first",
      message: "[Enhancement Pause] Issue #351 implement",
      accepts: (response) => response === "",
      signal: active.signal,
    });
    const cancelled = assert.rejects(first, /completed/u);
    const second = queue.request({
      id: "second",
      message: "Next Issue",
      accepts: () => true,
    });
    await tick();
    input.write("partial");
    const before = output().length;
    active.abort(new Error("completed"));
    await cancelled;
    await tick();
    const ended = output().slice(before);
    assert.match(
      ended,
      /Enhancement Pause ended[\s\S]*Completion recorded[\s\S]*Next Issue/u,
    );
    assert.doesNotMatch(ended, /\[Enhancement Pause\] Issue #351/u);
    input.end("unfinished");
    assert.equal(await second, null);
    assert.equal(
      await queue.request({ id: "eof", message: "EOF", accepts: () => true }),
      null,
    );
    assert.equal(run.signal.aborted, false);
    const after = output().length;
    operator.write("Finished");
    assert.equal(output().slice(after), "Finished\n");
  });
}

await test("non-TTY progress preserves partial input and pending cancellation updates the prompt", async (t) => {
  const { input, operator, queue, run, output } = terminalHarness(false);
  t.after(() => {
    run.abort();
    input.destroy();
  });
  const removed = new AbortController();
  const first = queue.request({
    id: "active",
    message: "Issue #351 review",
    accepts: (line) => line === "s",
  });
  await tick();
  const second = queue.request({
    id: "removed",
    message: "Never active",
    accepts: () => true,
    signal: removed.signal,
  });
  const cancelled = assert.rejects(second, /removed/u);
  input.write("s");
  operator.write("Sibling finished\rProgress continues");
  const before = output().length;
  removed.abort(new Error("removed"));
  await cancelled;
  const redrawn = output().slice(before);
  assert.match(redrawn, /Issue #351 review\n> /u);
  assert.doesNotMatch(redrawn, /pending|Never active/u);
  input.write("\n");
  assert.equal(await first, "s");
  assert.match(output(), /Sibling finished\nProgress continues/u);
});

await test("redraw retains wrapped Unicode input and its editing cursor", async (t) => {
  const { input, operator, queue, run, output } = terminalHarness();
  t.after(() => {
    run.abort();
    input.destroy();
  });
  const answer = "界".repeat(40) + "x";
  const waiting = queue.request({
    id: "wrapped",
    message: "Issue #351 implement",
    accepts: (line) => line === answer,
  });
  await tick();
  input.write(answer + "q\u001b[D");
  operator.write("Other Issue completed");
  operator.write("More progress");
  input.write("\u001b[3~\r");
  assert.equal(await waiting, answer);
  assert.match(
    output(),
    /Other Issue completed[\s\S]*More progress[\s\S]*Issue #351 implement/u,
  );
});
