import { randomUUID } from "node:crypto";
import type { AgentConfig } from "../config.ts";
import type {
  CreateTabOptions,
  Enhancement,
  EnhancementModule,
  TerminalPlugin,
} from "../terminal.ts";
import { boundedOperation, cancellableOperation } from "../run/operations.ts";

export type ConversationTab = Awaited<ReturnType<TerminalPlugin["createTab"]>>;

interface TabState {
  controller: AbortController;
  signal: AbortSignal;
  queue: Promise<void>;
  enhancement?: Enhancement;
  cleanup?: () => Promise<void>;
  stopping?: Promise<void>;
  stopped: boolean;
  closed: boolean;
  monitored: boolean;
  commanded: boolean;
  readiness?: { identity: string | undefined };
  assignment?: { id: string; expectedFile: string; recoveryText: string };
}

export class NativeConversations {
  private readonly tabs = new Map<ConversationTab, TabState>();
  private readonly plugin: TerminalPlugin;
  private readonly signal: AbortSignal | undefined;
  private readonly report: (message: string) => void;
  private readonly submitText: (action: () => Promise<void>) => Promise<void>;

  constructor(
    plugin: TerminalPlugin,
    signal?: AbortSignal,
    report: (message: string) => void = () => undefined,
    submitText: (action: () => Promise<void>) => Promise<void> = (action) =>
      action(),
  ) {
    this.plugin = plugin;
    this.signal = signal;
    this.report = report;
    this.submitText = submitText;
  }

  async create(
    options: CreateTabOptions,
    module?: EnhancementModule,
    config?: unknown,
  ): Promise<ConversationTab> {
    this.signal?.throwIfAborted();
    const controller = new AbortController();
    const signal = AbortSignal.any([
      controller.signal,
      ...(this.signal ? [this.signal] : []),
      ...(options.signal ? [options.signal] : []),
    ]);
    const tab = await this.plugin.createTab({ ...options, signal });
    const state: TabState = {
      controller,
      signal,
      queue: Promise.resolve(),
      stopped: false,
      closed: false,
      monitored: false,
      commanded: false,
    };
    this.tabs.set(tab, state);
    if (module) {
      const initializing = Promise.resolve().then(async () => {
        signal.throwIfAborted();
        const instance: unknown = await module.createEnhancement(
          tab.io,
          (id) => this.recover(tab, id),
          { cwd: options.cwd, env: options.env },
          config,
        );
        if (typeof instance === "object" && instance !== null) {
          const candidate = instance as Partial<Enhancement>;
          if (typeof candidate.stop === "function")
            state.cleanup = () => candidate.stop!();
          if (
            ["startMonitoring", "waitUntilReady", "onAssignment", "stop"].some(
              (method) => typeof Reflect.get(instance, method) !== "function",
            )
          )
            throw new Error(
              "Invalid enhancement: all four lifecycle methods must be callable",
            );
          state.enhancement = candidate as Enhancement;
        } else throw new Error("Invalid enhancement: expected an object");
      });
      // A cancelled factory still owns its resources until it transfers an instance.
      void initializing
        .then(
          async () => {
            if (signal.aborted) await this.stop(tab);
          },
          async (error: unknown) => {
            if (signal.aborted) {
              this.report(
                `Late enhancement initialization failed: ${String(error)}`,
              );
              await this.stop(tab);
            }
          },
        )
        .catch((error: unknown) =>
          this.report(`Enhancement cleanup failed: ${String(error)}`),
        );
      await cancellableOperation(() => initializing, signal);
    }
    signal.throwIfAborted();
    return tab;
  }

  async ready(
    tab: ConversationTab,
    profile: AgentConfig,
    sessionid: string | undefined,
    baseWait: () => Promise<void>,
  ): Promise<string | undefined> {
    const state = this.state(tab);
    const signal = state.signal;
    signal.throwIfAborted();
    if (state.readiness) return state.readiness.identity;
    if (!state.monitored) {
      if (state.enhancement)
        await cancellableOperation(
          () => state.enhancement!.startMonitoring(sessionid),
          signal,
        );
      state.monitored = true;
    }
    if (!state.commanded) {
      state.commanded = true;
      await this.start(tab, profile, sessionid);
    }
    const identity = state.enhancement
      ? await cancellableOperation(
          () => state.enhancement!.waitUntilReady(),
          signal,
        )
      : await baseWait();
    state.readiness = { identity: identity ?? undefined };
    return state.readiness.identity;
  }

  start(
    tab: ConversationTab,
    profile: AgentConfig,
    sessionid?: string,
  ): Promise<void> {
    return this.enqueue(tab, () =>
      this.plugin.execute(
        tab.handle,
        sessionid === undefined
          ? profile.start
          : profile.resume.replaceAll("{sessionref}", () => sessionid),
      ),
    );
  }

  submit(
    tab: ConversationTab,
    text: string,
    assignment?: { expectedFile: string; recoveryText: string },
  ): Promise<void> {
    return this.submitText(() =>
      boundedOperation(
        () =>
          this.enqueue(tab, async () => {
            const state = this.state(tab);
            if (assignment) {
              state.assignment = { ...assignment, id: randomUUID() };
              state.enhancement?.onAssignment({
                id: state.assignment.id,
                expectedFile: assignment.expectedFile,
              });
            }
            await this.input(tab, text);
          }),
        "terminal submitText; delivery is uncertain",
        this.state(tab).signal,
      ),
    );
  }

  private recover(tab: ConversationTab, id: string): Promise<void> {
    const state = this.state(tab);
    if (state.signal.aborted || state.assignment?.id !== id)
      return Promise.resolve();
    return this.enqueue(
      tab,
      async () => {
        if (state.signal.aborted || state.assignment?.id !== id) return;
        try {
          await this.input(tab, state.assignment.recoveryText);
        } catch (error) {
          // Only queue-start revocation is stale success; backend errors stay errors.
          if (state.signal.aborted && error === state.signal.reason) return;
          throw error;
        }
      },
      false,
    );
  }

  private async input(tab: ConversationTab, text: string): Promise<void> {
    try {
      await tab.io.submitText(text.replace(/\r\n?/gu, "\n"));
    } catch (error) {
      this.state(tab).controller.abort(
        new Error(`Terminal input failed: ${String(error)}`, { cause: error }),
      );
      void this.stop(tab).catch((cleanupError: unknown) =>
        this.report(`Enhancement cleanup failed: ${String(cleanupError)}`),
      );
      throw error;
    }
  }

  check(tab: ConversationTab): void {
    this.state(tab).signal.throwIfAborted();
  }

  complete(tab: ConversationTab): Promise<void> {
    return cancellableOperation(
      () =>
        this.enqueue(tab, () => {
          delete this.state(tab).assignment;
          return Promise.resolve();
        }),
      this.state(tab).signal,
    );
  }

  stop(tab: ConversationTab): Promise<void> {
    const state = this.state(tab);
    state.controller.abort(
      new Error("Runner Tab automatic capabilities revoked"),
    );
    delete state.assignment;
    if (state.stopped || !state.cleanup) return Promise.resolve();
    state.stopping ??= Promise.resolve()
      .then(() => state.cleanup!())
      .then(() => {
        state.stopped = true;
      })
      .finally(() => {
        delete state.stopping;
      });
    return state.stopping;
  }

  async stopAll(): Promise<void> {
    await Promise.all(
      [...this.tabs.keys()].map(async (tab) => {
        try {
          await this.stop(tab);
        } catch (error) {
          this.report(`Enhancement cleanup failed: ${String(error)}`);
        }
      }),
    );
  }

  async close(tab: ConversationTab): Promise<void> {
    const state = this.state(tab);
    await this.stop(tab);
    if (state.closed) return;
    await this.plugin.closeTab(tab.handle);
    state.closed = true;
  }

  private state(tab: ConversationTab): TabState {
    const state = this.tabs.get(tab);
    if (!state) throw new Error("Unknown Runner Tab");
    return state;
  }

  private enqueue<T>(
    tab: ConversationTab,
    action: () => Promise<T>,
    requireLive = true,
  ): Promise<T> {
    const state = this.state(tab);
    // A caller timeout must not release ordering before adapter input settles.
    const next = state.queue.then(() => {
      if (requireLive) state.signal.throwIfAborted();
      return action();
    });
    state.queue = next.then(
      () => undefined,
      () => undefined,
    );
    return next;
  }
}
