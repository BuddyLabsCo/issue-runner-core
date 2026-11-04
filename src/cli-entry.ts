import { executeCli } from "./cli.ts";
import { TerminalOperator } from "./adapters/terminal.ts";
import type { TerminalPluginModule } from "./terminal.ts";

export interface CliOptions {
  commandName: string;
  commandVersion: string;
  terminal: TerminalPluginModule;
  terminalPackageRoot: string;
  terminalCliEntry: string;
}

export async function runCli(options: CliOptions): Promise<void> {
  const controller = new AbortController();
  const cancel = () => controller.abort();
  process.once("SIGINT", cancel);
  process.once("SIGTERM", cancel);
  try {
    const result = await executeCli(process.argv.slice(2), {
      ...options,
      launchDirectory: process.cwd(),
      env: process.env,
      operator: new TerminalOperator(controller.signal),
      signal: controller.signal,
    });
    process.exitCode = result.exitCode;
  } finally {
    process.removeListener("SIGINT", cancel);
    process.removeListener("SIGTERM", cancel);
  }
}
