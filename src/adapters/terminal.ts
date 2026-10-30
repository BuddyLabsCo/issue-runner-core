import { createInterface } from "node:readline/promises";

import type { OperatorIO } from "../run/contracts.ts";

export class TerminalOperator implements OperatorIO {
  private readonly signal: AbortSignal | undefined;

  constructor(signal?: AbortSignal) {
    this.signal = signal;
  }
  write(message: string): void {
    process.stdout.write(`${message}\n`);
  }

  async pause(message: string, signal?: AbortSignal): Promise<string | null> {
    const activeSignal =
      this.signal && signal
        ? AbortSignal.any([this.signal, signal])
        : (signal ?? this.signal);
    const terminal = createInterface({
      input: process.stdin,
      output: process.stdout,
    });
    const closed = new Promise<null>((resolve) => {
      terminal.once("close", () => resolve(null));
    });
    try {
      return await Promise.race([
        terminal.question(
          `${message}\n> `,
          activeSignal ? { signal: activeSignal } : {},
        ),
        closed,
      ]);
    } catch {
      return null;
    } finally {
      terminal.close();
    }
  }
}
