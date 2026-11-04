export const terminalContractVersion = 2 as const;
export const enhancementContractVersion = 2 as const;

// Opaque, plugin-instance-owned reference; Core must not inspect or persist it.
export type TabHandle = object;

export interface CreateTabOptions {
  cwd: string;
  env: Readonly<Record<string, string>>;
  label: string;
  submitKey: string;
  signal?: AbortSignal;
}

export interface TerminalPlugin {
  createTab(
    options: CreateTabOptions,
  ): Promise<{ handle: TabHandle; io: TerminalIO }>;
  execute(handle: TabHandle, command: string): Promise<void>;
  closeTab(tab: TabHandle): Promise<void>;
}

export interface TerminalPluginModule {
  readonly contractVersion: typeof terminalContractVersion;
  createTerminalPlugin(config: unknown): Promise<TerminalPlugin>;
}

export interface TerminalIO {
  read(): Promise<string>;
  submitText(text: string): Promise<void>;
  sendKeys(keys: readonly string[]): Promise<void>;
}

export type RequestRecovery = (assignmentId: string) => Promise<void>;

export interface EnhancementContext {
  readonly cwd: string;
  readonly env: Readonly<Record<string, string>>;
}

export interface Enhancement {
  startMonitoring(sessionref?: string): Promise<void>;
  waitUntilReady(): Promise<string>;
  onAssignment(assignment: { id: string; expectedFile: string }): void;
  stop(): Promise<void>;
}

export interface EnhancementModule {
  readonly contractVersion: typeof enhancementContractVersion;
  createEnhancement(
    io: TerminalIO,
    requestRecovery: RequestRecovery,
    context: EnhancementContext,
    config: unknown,
  ): Promise<Enhancement>;
}
