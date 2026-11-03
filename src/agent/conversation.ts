import type { AgentConfig } from "../config.ts";
import type {
  CreateTabOptions,
  TabHandle,
  TerminalPlugin,
} from "../terminal.ts";

export class NativeConversations {
  private readonly queues = new Map<TabHandle, Promise<void>>();
  private readonly plugin: TerminalPlugin;
  private readonly signal: AbortSignal | undefined;

  constructor(plugin: TerminalPlugin, signal?: AbortSignal) {
    this.plugin = plugin;
    this.signal = signal;
  }

  async create(options: CreateTabOptions): Promise<TabHandle> {
    this.signal?.throwIfAborted();
    const tab = await this.plugin.createTab(options);
    this.queues.set(tab, Promise.resolve());
    return tab;
  }

  start(
    tab: TabHandle,
    profile: AgentConfig,
    sessionid?: string,
  ): Promise<string | undefined> {
    return this.enqueue(tab, () =>
      sessionid === undefined
        ? this.plugin.start(tab, profile.start)
        : this.plugin.resume(
            tab,
            profile.resume.replaceAll("{sessionref}", () => sessionid),
            sessionid,
          ),
    );
  }

  submit(
    tab: TabHandle,
    text: string,
    chord = "Enter",
    expectedFile?: string,
    recoveryText?: string,
  ): Promise<void> {
    return this.enqueue(tab, () =>
      this.plugin.submitText(
        tab,
        text.replace(/\r\n?/gu, "\n"),
        chord,
        expectedFile,
        recoveryText,
      ),
    );
  }

  async close(tab: TabHandle): Promise<void> {
    await this.enqueue(tab, () => this.plugin.closeTab(tab));
    this.queues.delete(tab);
  }

  private enqueue<T>(tab: TabHandle, action: () => Promise<T>): Promise<T> {
    const previous = this.queues.get(tab);
    if (!previous) throw new Error("Unknown Runner Tab");
    const next = previous.then(() => {
      this.signal?.throwIfAborted();
      return action();
    });
    // Preserve ordering after a failure; the caller decides whether to retry.
    this.queues.set(
      tab,
      next.then(
        () => undefined,
        () => undefined,
      ),
    );
    return next;
  }
}
