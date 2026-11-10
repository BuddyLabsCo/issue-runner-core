import { clearScreenDown, cursorTo, moveCursor } from "node:readline";
import { createInterface, type Interface } from "node:readline/promises";
import { Transform, type Readable, type Writable } from "node:stream";
import type { ReadStream } from "node:tty";

import type { ConfirmationStatus } from "../run/confirmations.ts";
import type { OperatorIO } from "../run/contracts.ts";

export class TerminalOperator implements OperatorIO {
  private readonly signal: AbortSignal | undefined;
  private readonly input: Readable &
    Partial<Pick<ReadStream, "isRaw" | "setRawMode">>;
  private readonly output: Writable & { isTTY?: boolean };
  private status: ConfirmationStatus = { active: undefined, pending: [] };
  private trailingCR = false;
  private waiting:
    | { terminal: Interface; message: string; signal: AbortSignal | undefined }
    | undefined;

  constructor(
    signal?: AbortSignal,
    streams: { input: Readable; output: Writable & { isTTY?: boolean } } = {
      input: process.stdin,
      output: process.stdout,
    },
  ) {
    this.signal = signal;
    this.input = streams.input;
    this.output = streams.output;
  }

  write(message: string): void {
    this.clearInput();
    if (this.waiting?.signal?.aborted) {
      this.waiting.terminal.close();
      this.waiting = undefined;
    }
    this.output.write(`${message.replace(/\r\n?/gu, "\n")}\n`);
    this.redraw();
  }

  confirmationStatus(status: ConfirmationStatus): void {
    this.status = status;
    if (this.waiting && !this.waiting.signal?.aborted && status.active) {
      this.clearInput();
      this.redraw();
    }
  }

  private clearInput(): void {
    if (!this.waiting) return;
    if (this.output.isTTY) {
      const { rows } = this.waiting.terminal.getCursorPos();
      moveCursor(this.output, 0, -rows);
      cursorTo(this.output, 0);
      clearScreenDown(this.output);
    } else {
      this.output.write("\n");
    }
  }

  private redraw(): void {
    const waiting = this.waiting;
    if (!waiting || waiting.signal?.aborted) return;
    this.output.write(`${waiting.message.replace(/\r\n?/gu, "\n")}\n`);
    if (this.status.pending.length)
      this.output.write(
        `[${this.status.pending.length} pending confirmation(s)]\n`,
      );
    // Readline refresh moves up by the wrapped input's cursor row count.
    if (this.output.isTTY)
      this.output.write("\n".repeat(waiting.terminal.getCursorPos().rows));
    waiting.terminal.prompt(true);
  }

  async pause(message: string, signal?: AbortSignal): Promise<string | null> {
    const activeSignal =
      this.signal && signal
        ? AbortSignal.any([this.signal, signal])
        : (signal ?? this.signal);
    if (
      activeSignal?.aborted ||
      this.input.readableEnded ||
      this.input.destroyed
    )
      return null;
    const input = new Transform({
      transform: (chunk: Buffer, _encoding, done) => {
        // A CRLF remains one Enter even if its LF arrives in a later request.
        const pairedLF = this.trailingCR && chunk[0] === 10;
        this.trailingCR = chunk.at(-1) === 13;
        done(null, pairedLF ? chunk.subarray(1) : chunk);
      },
    });
    Object.defineProperties(input, {
      isRaw: { get: () => this.input.isRaw },
      setRawMode: {
        value: (enabled: boolean) => this.input.setRawMode?.(enabled),
      },
    });
    const terminal = createInterface({
      input,
      output: this.output,
      crlfDelay: Infinity,
    });
    this.input.pipe(input);
    const closed = new Promise<null>((resolve) => {
      terminal.once("close", () => resolve(null));
    });
    this.waiting = { terminal, message, signal: activeSignal };
    try {
      this.output.write(`${message.replace(/\r\n?/gu, "\n")}\n`);
      if (this.status.pending.length)
        this.output.write(
          `[${this.status.pending.length} pending confirmation(s)]\n`,
        );
      return await Promise.race([
        terminal.question("> ", activeSignal ? { signal: activeSignal } : {}),
        closed,
      ]);
    } catch {
      return null;
    } finally {
      this.waiting = undefined;
      this.input.unpipe(input);
      terminal.close();
      input.destroy();
      if (!this.output.isTTY) this.output.write("\n");
    }
  }
}
