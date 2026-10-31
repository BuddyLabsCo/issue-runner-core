import type { AuditEvent, AuditLog } from "../audit.ts";
import type { OperationProgress } from "../recovery.ts";
import type { Clock, OperatorIO, RetryPolicy } from "./contracts.ts";

export class OperatorCancelled extends Error {}
export class OperationStopped extends Error {}
export class TicketSkipped extends Error {}

export async function cancellableSleep(
  clock: Clock,
  milliseconds: number,
  signal: AbortSignal,
): Promise<void> {
  signal.throwIfAborted();
  let abort!: () => void;
  const cancelled = new Promise<never>((_resolve, reject) => {
    abort = () => {
      const reason: unknown = signal.reason;
      reject(reason instanceof Error ? reason : new Error(String(reason)));
    };
    signal.addEventListener("abort", abort, { once: true });
  });
  try {
    await Promise.race([clock.sleep(milliseconds, signal), cancelled]);
    signal.throwIfAborted();
  } finally {
    signal.removeEventListener("abort", abort);
  }
}

export interface OperationOptions<T> {
  operator?: OperatorIO;
  retry?: "automatic" | "manual" | "never";
  reconcile?: () => Promise<
    { outcome: "pending" } | { outcome: "completed"; result: T }
  >;
  recovery?: {
    states: Record<string, OperationProgress>;
    key: string;
    persist: () => Promise<void>;
  };
}

// A rejected bound cannot cancel the underlying I/O or prove that no effect occurred.
export async function boundedOperation<T>(
  action: () => Promise<T>,
  description: string,
  signal?: AbortSignal,
): Promise<T> {
  signal?.throwIfAborted();
  let timer: ReturnType<typeof setTimeout> | undefined;
  let abort!: () => void;
  const stopped = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(
      () =>
        reject(
          new Error(
            `${description} timed out after 60000ms; operation may be partial`,
          ),
        ),
      60_000,
    );
    abort = () => {
      const reason: unknown = signal?.reason;
      reject(reason instanceof Error ? reason : new Error(String(reason)));
    };
    signal?.addEventListener("abort", abort, { once: true });
  });
  try {
    return await Promise.race([action(), stopped]);
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener("abort", abort);
  }
}

export function scopeOperator(operator: OperatorIO, scope: string): OperatorIO {
  return {
    skipScope: scope,
    ...(operator.intervene ? { intervene: () => operator.intervene!() } : {}),
    write: (message) => operator.write(message),
    pause: (message, signal) => operator.pause(message, signal),
  };
}

export function serializeOperator(
  operator: OperatorIO,
  controller: AbortController,
  signal: AbortSignal,
): OperatorIO & { advance<T>(action: () => Promise<T>): Promise<T> } {
  let pending: Promise<unknown> = Promise.resolve();
  let pauses = 0;
  let resumed: Promise<void>;
  let resume!: () => void;
  const intervene = () => {
    if (pauses++ === 0)
      resumed = new Promise<void>((resolve) => {
        resume = resolve;
      });
    return () => {
      if (--pauses === 0) resume();
    };
  };
  return {
    intervene,
    advance(action) {
      if (pauses > 0) return resumed.then(() => this.advance(action));
      signal.throwIfAborted();
      return action();
    },
    write: (message) => operator.write(message),
    pause(message) {
      const release = intervene();
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
              if (
                response === "" ||
                response === "s" ||
                response === "q" ||
                response === null
              )
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
        .finally(release);
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
  let release: (() => void) | undefined;
  try {
    for (;;) {
      signal?.throwIfAborted();
      try {
        await action();
        return;
      } catch {
        release ??= operator.intervene?.();
        await pauseForOperator(
          operator,
          "Audit write failed. Retry the same log action.",
          signal,
        );
      }
    }
  } finally {
    release?.();
  }
}

export async function pauseForOperator(
  operator: OperatorIO,
  reason: string,
  signal?: AbortSignal,
  allowsSkip = false,
): Promise<void> {
  const release = operator.intervene?.();
  try {
    for (;;) {
      signal?.throwIfAborted();
      const response = await operator.pause(
        `${reason} Enter to retry, ${allowsSkip && operator.skipScope ? `s to skip ${operator.skipScope}, ` : ""}q/EOF to cancel. Other input is unsupported.`,
        signal,
      );
      signal?.throwIfAborted();
      if (response === "q" || response === null)
        throw new OperatorCancelled("operator cancelled");
      if (response === "") return;
      if (response === "s" && allowsSkip && operator.skipScope)
        throw new TicketSkipped(
          `skipped ${operator.skipScope}; side effects may remain, including unknown resources from unobserved writes`,
        );
      operator.write("Unsupported input.");
    }
  } finally {
    release?.();
  }
}

interface ExternalOperation<T> extends OperationOptions<T> {
  action: () => Promise<T>;
  audit: AuditLog;
  event: (attempt: number) => Omit<AuditEvent, "result" | "error">;
  clock: Clock;
  operator: OperatorIO;
  retryPolicy: RetryPolicy;
  signal?: AbortSignal;
}

async function attemptOperation<T>(
  operation: ExternalOperation<T>,
  attempt: number,
): Promise<
  { outcome: "succeeded"; result: T } | { outcome: "failed"; error: unknown }
> {
  const { signal, operator } = operation;
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
    await record(
      "failed",
      error instanceof Error ? error.message : String(error),
    );
    if (
      error instanceof OperatorCancelled ||
      error instanceof OperationStopped ||
      error instanceof TicketSkipped
    )
      throw error;
    const state = await operation.reconcile?.();
    if (state?.outcome !== "completed") {
      if (operation.retry === "never") throw error;
      return { outcome: "failed", error };
    }
    result = state.result;
  }
  // Logging recovery must never replay the completed business action.
  await record("succeeded", null);
  signal?.throwIfAborted();
  return { outcome: "succeeded", result };
}

// Source policy: additional attempts, last delay reused, then non-Agent pause.
export async function externalRead<T>(
  operation: ExternalOperation<T>,
): Promise<T> {
  const { signal, operator, retryPolicy: policy } = operation;
  const retries =
    operation.retry === undefined || operation.retry === "automatic"
      ? policy.operationRetry
      : 0;
  const recovery = operation.recovery;
  const persist = async (state?: OperationProgress) => {
    if (!recovery) return;
    if (state) recovery.states[recovery.key] = state;
    else delete recovery.states[recovery.key];
    await recovery.persist();
  };
  let progress = recovery?.states[recovery.key] ?? { consumed: 0, error: "" };
  for (;;) {
    if (progress.consumed > retries) {
      await pauseForOperator(
        operator,
        `Operation failed: ${progress.error || "previous attempt did not complete"}`,
        signal,
        true,
      );
      progress = { consumed: 0, error: "" };
      await persist();
      continue;
    }
    signal?.throwIfAborted();
    if (progress.notBefore !== undefined) {
      const remaining = progress.notBefore - operation.clock.now().getTime();
      if (remaining > 0) await operation.clock.sleep(remaining);
      signal?.throwIfAborted();
      delete progress.notBefore;
    }
    const attempt = progress.consumed + 1;
    // Manual creation first reconciles any retained resource on recovery.
    if (operation.retry !== "manual") {
      progress.consumed = attempt;
      await persist(progress);
    }
    const result = await attemptOperation(operation, attempt);
    if (result.outcome === "succeeded") {
      if (progress.consumed) await persist();
      return result.result;
    }
    progress.consumed = attempt;
    progress.error =
      result.error instanceof Error
        ? result.error.message
        : String(result.error);
    if (progress.consumed <= retries) {
      const delay =
        policy.operationRetryDelay[
          Math.min(progress.consumed - 1, policy.operationRetryDelay.length - 1)
        ]!;
      progress.notBefore = operation.clock.now().getTime() + delay * 1000;
    }
    await persist(progress);
  }
}
