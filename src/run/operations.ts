import type { AuditEvent, AuditLog } from "../audit.ts";
import type { Clock, OperatorIO, RetryPolicy } from "./contracts.ts";

export class OperatorCancelled extends Error {}

export function serializeOperator(
  operator: OperatorIO,
  controller: AbortController,
  signal: AbortSignal,
): OperatorIO & { advance<T>(action: () => Promise<T>): Promise<T> } {
  let pending: Promise<unknown> = Promise.resolve();
  let pauses = 0;
  let resumed: Promise<void>;
  let resume!: () => void;
  return {
    advance(action) {
      if (pauses > 0) return resumed.then(() => this.advance(action));
      signal.throwIfAborted();
      return action();
    },
    write: (message) => operator.write(message),
    pause(message) {
      if (pauses++ === 0)
        resumed = new Promise<void>((resolve) => {
          resume = resolve;
        });
      const next = pending
        .then(async () => {
          signal.throwIfAborted();
          let abort!: () => void;
          const cancelled = new Promise<never>((_resolve, reject) => {
            abort = () => {
              const reason: unknown = signal.reason;
              reject(
                reason instanceof Error ? reason : new Error(String(reason)),
              );
            };
            signal.addEventListener("abort", abort, { once: true });
          });
          try {
            for (;;) {
              const response = await Promise.race([
                Promise.resolve().then(() => {
                  signal.throwIfAborted();
                  return operator.pause(message, signal);
                }),
                cancelled,
              ]);
              signal.throwIfAborted();
              if (response === "q" || response === null)
                controller.abort(new OperatorCancelled("operator cancelled"));
              if (response === "" || response === "q" || response === null)
                return response;
              operator.write("Unsupported input.");
            }
          } catch (error) {
            controller.abort(error);
            throw error;
          } finally {
            signal.removeEventListener("abort", abort);
          }
        })
        .finally(() => {
          if (--pauses === 0) resume();
        });
      pending = next.catch(() => undefined);
      return next;
    },
  };
}

export async function supervisedAuditWrite(
  action: () => Promise<void>,
  operator: OperatorIO,
  signal?: AbortSignal,
): Promise<void> {
  for (;;) {
    signal?.throwIfAborted();
    try {
      await action();
      return;
    } catch {
      await pauseForOperator(
        operator,
        "Audit write failed. Retry the same log action.",
        signal,
      );
    }
  }
}

async function pauseForOperator(
  operator: OperatorIO,
  reason: string,
  signal?: AbortSignal,
): Promise<void> {
  for (;;) {
    signal?.throwIfAborted();
    const response = await operator.pause(
      `${reason} Enter to retry, q/EOF to cancel. Other input is unsupported.`,
      signal,
    );
    signal?.throwIfAborted();
    if (response === "q" || response === null)
      throw new OperatorCancelled("operator cancelled");
    if (response === "") return;
    operator.write("Unsupported input.");
  }
}

// Source read policy: additional attempts, last delay reused, then non-Agent pause.
export async function externalRead<T>(operation: {
  action: () => Promise<T>;
  audit: AuditLog;
  event: (attempt: number) => Omit<AuditEvent, "result" | "error">;
  clock: Clock;
  operator: OperatorIO;
  retryPolicy: RetryPolicy;
  signal?: AbortSignal;
}): Promise<T> {
  const { signal, operator, retryPolicy: policy } = operation;
  for (;;) {
    let lastError: unknown;
    for (let attempt = 1; attempt <= policy.operationRetry + 1; attempt += 1) {
      signal?.throwIfAborted();
      const event = operation.event(attempt);
      const record = (result: string, error: string | null) =>
        supervisedAuditWrite(
          () => operation.audit.append({ ...event, result, error }),
          operator,
          signal,
        );
      await record("started", null);
      let result: T;
      try {
        result = await operation.action();
      } catch (error) {
        signal?.throwIfAborted();
        lastError = error;
        await record(
          "failed",
          error instanceof Error ? error.message : "external read failed",
        );
        if (error instanceof OperatorCancelled) throw error;
        if (attempt <= policy.operationRetry) {
          const delay =
            policy.operationRetryDelay[
              Math.min(attempt - 1, policy.operationRetryDelay.length - 1)
            ]!;
          await operation.clock.sleep(delay * 1000);
        }
        continue;
      }
      // Retrying this audit append must never replay the completed observation.
      await record("succeeded", null);
      signal?.throwIfAborted();
      return result;
    }
    await pauseForOperator(
      operator,
      `Operation failed: ${lastError instanceof Error ? lastError.message : String(lastError)}`,
      signal,
    );
  }
}
