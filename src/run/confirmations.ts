import type { OperatorIO } from "./contracts.ts";
import { cancellableOperation } from "./operations.ts";

interface ConfirmationIdentity {
  id: string;
  message: string;
}

interface ConfirmationRequest extends ConfirmationIdentity {
  accepts(response: string): boolean;
  signal?: AbortSignal;
}

interface PendingConfirmation {
  request: ConfirmationRequest;
  signal: AbortSignal;
  resolve(response: string | null): void;
  reject(reason: unknown): void;
  cancel: () => void;
}

export class TerminalConfirmations {
  private readonly pending: PendingConfirmation[] = [];
  private active: PendingConfirmation | undefined;
  private readonly operator: Pick<OperatorIO, "pause" | "write">;
  private readonly signal: AbortSignal;

  constructor(
    operator: Pick<OperatorIO, "pause" | "write">,
    signal: AbortSignal,
  ) {
    this.operator = operator;
    this.signal = signal;
  }

  get status(): {
    active: ConfirmationIdentity | undefined;
    pending: readonly ConfirmationIdentity[];
  } {
    const identity = ({ request }: PendingConfirmation) => ({
      id: request.id,
      message: request.message,
    });
    return {
      active: this.active && identity(this.active),
      pending: this.pending.map(identity),
    };
  }

  request(request: ConfirmationRequest): Promise<string | null> {
    const signal = AbortSignal.any(
      request.signal ? [this.signal, request.signal] : [this.signal],
    );
    if (signal.aborted) {
      const reason: unknown = signal.reason;
      return Promise.reject(
        reason instanceof Error ? reason : new Error(String(reason)),
      );
    }
    return new Promise((resolve, reject) => {
      const entry: PendingConfirmation = {
        request,
        signal,
        resolve,
        reject,
        cancel: () => {
          const index = this.pending.indexOf(entry);
          if (index < 0) return;
          this.pending.splice(index, 1);
          signal.removeEventListener("abort", entry.cancel);
          const reason: unknown = signal.reason;
          reject(reason instanceof Error ? reason : new Error(String(reason)));
        },
      };
      signal.addEventListener("abort", entry.cancel, { once: true });
      this.pending.push(entry);
      void this.advance();
    });
  }

  private async advance(): Promise<void> {
    if (this.active) return;
    const entry = this.pending.shift();
    if (!entry) return;
    entry.signal.removeEventListener("abort", entry.cancel);
    this.active = entry;
    try {
      entry.resolve(await this.read(entry));
    } catch (error) {
      entry.reject(error);
    } finally {
      this.active = undefined;
      void this.advance();
    }
  }

  private async read({
    request,
    signal,
  }: PendingConfirmation): Promise<string | null> {
    for (;;) {
      const response = await cancellableOperation(
        () =>
          Promise.resolve().then(() => {
            signal.throwIfAborted();
            return this.operator.pause(request.message, signal);
          }),
        signal,
      );
      if (response === null || request.accepts(response)) return response;
      this.operator.write("Unsupported input.");
    }
  }
}
