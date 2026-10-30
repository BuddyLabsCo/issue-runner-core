import type { AgentConfig } from "../config.ts";
import type {
  CreateTabOptions,
  TabHandle,
  TerminalPlugin,
} from "../terminal.ts";
import type { Clock } from "../run/contracts.ts";

export class NativeConversations {
  private readonly queues = new Map<TabHandle, Promise<void>>();
  private readonly plugin: TerminalPlugin;
  private readonly clock: Clock;
  private readonly signal: AbortSignal | undefined;

  constructor(plugin: TerminalPlugin, clock: Clock, signal?: AbortSignal) {
    this.plugin = plugin;
    this.clock = clock;
    this.signal = signal;
  }

  async open(
    options: CreateTabOptions,
    profile: AgentConfig,
    sessionid?: string,
  ): Promise<TabHandle> {
    this.signal?.throwIfAborted();
    const tab = await this.plugin.createTab(options);
    this.queues.set(tab, Promise.resolve());
    const command =
      sessionid === undefined
        ? profile.start
        : profile.resume.replaceAll("{sessionref}", () => sessionid);
    await this.submit(tab, command, "Enter");
    this.signal?.throwIfAborted();
    await this.clock.sleep(10_000);
    this.signal?.throwIfAborted();
    return tab;
  }

  submit(tab: TabHandle, text: string, chord = "Enter"): Promise<void> {
    return this.enqueue(tab, () =>
      this.plugin.submitText(tab, text.replace(/\r\n?/gu, "\n"), chord),
    );
  }

  async close(tab: TabHandle): Promise<void> {
    await this.enqueue(tab, () => this.plugin.closeTab(tab));
    this.queues.delete(tab);
  }

  private enqueue(tab: TabHandle, action: () => Promise<void>): Promise<void> {
    const previous = this.queues.get(tab);
    if (!previous) throw new Error("Unknown Runner Tab");
    const next = previous.then(() => {
      this.signal?.throwIfAborted();
      return action();
    });
    // Preserve ordering after a failure; the caller decides whether to retry.
    this.queues.set(
      tab,
      next.catch(() => undefined),
    );
    return next;
  }
}
