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

  async pause(message: string): Promise<string | null> {
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
          this.signal ? { signal: this.signal } : {},
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
