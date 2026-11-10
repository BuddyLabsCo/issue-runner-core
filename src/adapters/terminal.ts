import { clearScreenDown, cursorTo, moveCursor } from "node:readline";
import { createInterface, type Interface } from "node:readline/promises";
import type { Readable, Writable } from "node:stream";

import type { ConfirmationStatus } from "../run/confirmations.ts";
import type { OperatorIO } from "../run/contracts.ts";

export class TerminalOperator implements OperatorIO {
  private readonly signal: AbortSignal | undefined;
  private readonly input: Readable;
  private readonly output: Writable & { isTTY?: boolean };
  private status: ConfirmationStatus = { active: undefined, pending: [] };
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
    const terminal = createInterface({
      input: this.input,
      output: this.output,
    });
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
      terminal.close();
      if (!this.output.isTTY) this.output.write("\n");
    }
  }
}
