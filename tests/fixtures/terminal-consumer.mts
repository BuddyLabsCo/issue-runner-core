import type {
  CreateTabOptions,
  Enhancement,
  EnhancementContext,
  EnhancementHost,
  EnhancementModule,
  TabHandle,
  TerminalPlugin,
  TerminalPluginModule,
} from "issue-runner-core/terminal";

type Equal<A, B> =
  (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2
    ? true
    : false;
type Assert<T extends true> = T;

export type ContractChecks = [
  Assert<
    Equal<
      typeof import("issue-runner-core/terminal").terminalContractVersion,
      1
    >
  >,
  Assert<
    Equal<
      typeof import("issue-runner-core/terminal").enhancementContractVersion,
      1
    >
  >,
  Assert<
    Equal<
      EnhancementHost,
      {
        read(): Promise<string>;
        submitText(text: string): Promise<void>;
        sendKeys(keys: readonly string[]): Promise<void>;
        requestRecovery(): Promise<void>;
      }
    >
  >,
  Assert<
    Equal<
      EnhancementContext,
      {
        readonly cwd: string;
        readonly env: Readonly<Record<string, string>>;
      }
    >
  >,
  Assert<
    Equal<
      Enhancement,
      {
        startMonitoring(sessionref?: string): Promise<void>;
        waitUntilReady(): Promise<string>;
        onAssignment(expectedFile: string): void;
        stop(): Promise<void>;
      }
    >
  >,
  Assert<
    Equal<
      EnhancementModule,
      {
        readonly contractVersion: 1;
        createEnhancement(
          host: EnhancementHost,
          context: EnhancementContext,
          config: unknown,
        ): Promise<Enhancement>;
      }
    >
  >,
  Assert<Equal<TabHandle, object>>,
  Assert<
    Equal<
      CreateTabOptions,
      {
        cwd: string;
        env: Readonly<Record<string, string>>;
        label: string;
        agent: string;
        submitKey: string;
        signal?: AbortSignal;
      }
    >
  >,
  Assert<
    Equal<
      TerminalPlugin,
      {
        createTab(options: CreateTabOptions): Promise<TabHandle>;
        start(
          tab: TabHandle,
          startCommand: string,
        ): Promise<string | undefined>;
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
    >
  >,
  Assert<
    Equal<
      TerminalPluginModule,
      {
        readonly contractVersion: 1;
        createTerminalPlugin(config: unknown): Promise<TerminalPlugin>;
      }
    >
  >,
  Assert<
    Equal<
      keyof typeof import("issue-runner-core/terminal"),
      "terminalContractVersion" | "enhancementContractVersion"
    >
  >,
];
