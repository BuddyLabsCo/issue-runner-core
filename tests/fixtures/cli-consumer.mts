import { runCli, type CliOptions } from "issue-runner-core/cli";
import type { TerminalPluginModule } from "issue-runner-core/terminal";

type Equal<A, B> =
  (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2
    ? true
    : false;
type Assert<T extends true> = T;

export type CliChecks = [
  Assert<
    Equal<
      CliOptions,
      {
        commandName: string;
        commandVersion: string;
        terminal: TerminalPluginModule;
        terminalPackageRoot: string;
        terminalCliEntry: string;
      }
    >
  >,
  Assert<Equal<typeof runCli, (options: CliOptions) => Promise<void>>>,
  Assert<Equal<keyof typeof import("issue-runner-core/cli"), "runCli">>,
];

// @ts-expect-error The application seam is private.
export type { CliDependencies } from "issue-runner-core/cli";
// @ts-expect-error Structured results are private to Core.
export type { CliResult } from "issue-runner-core/cli";

export async function command(terminal: TerminalPluginModule): Promise<void> {
  await runCli({
    commandName: "generic-terminal",
    commandVersion: "2.3.4",
    terminal,
    terminalPackageRoot: "/installation/generic-terminal",
    terminalCliEntry: "/installation/generic-terminal/cli.mjs",
  });
}
