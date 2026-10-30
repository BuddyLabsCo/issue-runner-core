import type {
  CreateTabOptions,
  TabHandle,
  TerminalPlugin,
  TerminalPluginModule,
} from "issue-runner-core/terminal";

type Equal<A, B> =
  (<T>() => T extends A ? 1 : 2) extends
  (<T>() => T extends B ? 1 : 2) ? true : false;
type Assert<T extends true> = T;

export type ContractChecks = [
  Assert<Equal<TabHandle, object>>,
  Assert<Equal<CreateTabOptions, {
    cwd: string;
    env: Readonly<Record<string, string>>;
    label: string;
  }>>,
  Assert<Equal<TerminalPlugin, {
    createTab(options: CreateTabOptions): Promise<TabHandle>;
    submitText(tab: TabHandle, text: string, submitKey?: string): Promise<void>;
    closeTab(tab: TabHandle): Promise<void>;
  }>>,
  Assert<Equal<TerminalPluginModule, {
    readonly contractVersion: 1;
    createTerminalPlugin(): Promise<TerminalPlugin>;
  }>>,
  Assert<Equal<
    keyof typeof import("issue-runner-core/terminal"),
    "terminalContractVersion"
  >>,
];
