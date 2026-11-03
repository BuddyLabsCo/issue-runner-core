export const terminalContractVersion = 1 as const;
export const enhancementContractVersion = 1 as const;

// Opaque, plugin-instance-owned reference; Core must not inspect or persist it.
export type TabHandle = object;

export interface CreateTabOptions {
  cwd: string;
  env: Readonly<Record<string, string>>;
  label: string;
  agent: string;
  submitKey: string;
  signal?: AbortSignal;
}

export interface TerminalPlugin {
  createTab(options: CreateTabOptions): Promise<TabHandle>;
  start(tab: TabHandle, startCommand: string): Promise<string | undefined>;
  resume(
    tab: TabHandle,
    resumeCommand: string,
    sessionref: string,
  ): Promise<string>;
  submitText(
    tab: TabHandle,
    text: string,
    submitKey?: string,
    expectedFile?: string,
    recoveryText?: string,
  ): Promise<void>;
  closeTab(tab: TabHandle): Promise<void>;
}

export interface TerminalPluginModule {
  readonly contractVersion: typeof terminalContractVersion;
  createTerminalPlugin(config: unknown): Promise<TerminalPlugin>;
}

export interface EnhancementHost {
  read(): Promise<string>;
  submitText(text: string): Promise<void>;
  sendKeys(keys: readonly string[]): Promise<void>;
  requestRecovery(): Promise<void>;
}

export interface EnhancementContext {
  readonly cwd: string;
  readonly env: Readonly<Record<string, string>>;
}

export interface Enhancement {
  startMonitoring(sessionref?: string): Promise<void>;
  waitUntilReady(): Promise<string>;
  onAssignment(expectedFile: string): void;
  stop(): Promise<void>;
}

export interface EnhancementModule {
  readonly contractVersion: typeof enhancementContractVersion;
  createEnhancement(
    host: EnhancementHost,
    context: EnhancementContext,
    config: unknown,
  ): Promise<Enhancement>;
}
