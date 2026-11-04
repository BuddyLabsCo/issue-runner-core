import type { AgentConfig } from "../config.ts";
import type { CreateTabOptions, TerminalPlugin } from "../terminal.ts";

export type ConversationTab = Awaited<ReturnType<TerminalPlugin["createTab"]>>;

export class NativeConversations {
  private readonly queues = new Map<ConversationTab, Promise<void>>();
  private readonly plugin: TerminalPlugin;
  private readonly signal: AbortSignal | undefined;

  constructor(plugin: TerminalPlugin, signal?: AbortSignal) {
    this.plugin = plugin;
    this.signal = signal;
  }

  async create(options: CreateTabOptions): Promise<ConversationTab> {
    this.signal?.throwIfAborted();
    const tab = await this.plugin.createTab(options);
    this.queues.set(tab, Promise.resolve());
    return tab;
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

  submit(tab: ConversationTab, text: string): Promise<void> {
    return this.enqueue(tab, () =>
      tab.io.submitText(text.replace(/\r\n?/gu, "\n")),
    );
  }

  async close(tab: ConversationTab): Promise<void> {
    await this.enqueue(tab, () => this.plugin.closeTab(tab.handle));
    this.queues.delete(tab);
  }

  private enqueue<T>(
    tab: ConversationTab,
    action: () => Promise<T>,
  ): Promise<T> {
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
