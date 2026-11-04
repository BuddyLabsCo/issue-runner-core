import type {
  CreateTabOptions,
  Enhancement,
  EnhancementContext,
  TerminalIO,
  EnhancementModule,
  RequestRecovery,
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
      2
    >
  >,
  Assert<
    Equal<
      typeof import("issue-runner-core/terminal").enhancementContractVersion,
      2
    >
  >,
  Assert<
    Equal<
      TerminalIO,
      {
        read(): Promise<string>;
        submitText(text: string): Promise<void>;
        sendKeys(keys: readonly string[]): Promise<void>;
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
        onAssignment(assignment: { id: string; expectedFile: string }): void;
        stop(): Promise<void>;
      }
    >
  >,
  Assert<
    Equal<
      EnhancementModule,
      {
        readonly contractVersion: 2;
        createEnhancement(
          io: TerminalIO,
          requestRecovery: RequestRecovery,
          context: EnhancementContext,
          config: unknown,
        ): Promise<Enhancement>;
      }
    >
  >,
  Assert<Equal<TabHandle, object>>,
  Assert<Equal<RequestRecovery, (assignmentId: string) => Promise<void>>>,
  Assert<
    Equal<
      CreateTabOptions,
      {
        cwd: string;
        env: Readonly<Record<string, string>>;
        label: string;
        submitKey: string;
        signal?: AbortSignal;
      }
    >
  >,
  Assert<
    Equal<
      TerminalPlugin,
      {
        createTab(
          options: CreateTabOptions,
        ): Promise<{ handle: TabHandle; io: TerminalIO }>;
        execute(handle: TabHandle, command: string): Promise<void>;
        closeTab(tab: TabHandle): Promise<void>;
      }
    >
  >,
  Assert<
    Equal<
      TerminalPluginModule,
      {
        readonly contractVersion: 2;
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
