export const terminalContractVersion = 1 as const;

// Opaque, plugin-instance-owned reference; Core must not inspect or persist it.
export type TabHandle = object;

export interface CreateTabOptions {
  cwd: string;
  env: Readonly<Record<string, string>>;
  label: string;
}

export interface TerminalPlugin {
  createTab(options: CreateTabOptions): Promise<TabHandle>;
  submitText(tab: TabHandle, text: string, submitKey?: string): Promise<void>;
  closeTab(tab: TabHandle): Promise<void>;
}

export interface TerminalPluginModule {
  readonly contractVersion: typeof terminalContractVersion;
  createTerminalPlugin(): Promise<TerminalPlugin>;
}
