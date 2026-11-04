import { terminalContractVersion, type TerminalPlugin } from "../terminal.ts";

export async function loadTerminalPlugin(
  commandName: string,
  module: unknown,
  config: unknown,
): Promise<TerminalPlugin> {
  try {
    if (
      typeof module !== "object" ||
      module === null ||
      !("contractVersion" in module) ||
      module.contractVersion !== terminalContractVersion
    )
      throw new Error(
        `plugin must export contractVersion ${terminalContractVersion}`,
      );
    if (
      !("createTerminalPlugin" in module) ||
      typeof module.createTerminalPlugin !== "function"
    )
      throw new Error(
        "plugin must export a createTerminalPlugin(config) factory",
      );
    const factory = module.createTerminalPlugin as (
      config: unknown,
    ) => Promise<unknown>;
    const plugin = await factory(config);
    if (
      typeof plugin !== "object" ||
      plugin === null ||
      !("createTab" in plugin) ||
      typeof plugin.createTab !== "function" ||
      !("start" in plugin) ||
      typeof plugin.start !== "function" ||
      !("resume" in plugin) ||
      typeof plugin.resume !== "function" ||
      !("submitText" in plugin) ||
      typeof plugin.submitText !== "function" ||
      !("closeTab" in plugin) ||
      typeof plugin.closeTab !== "function"
    )
      throw new Error(
        "factory must return createTab, start, resume, submitText, and closeTab methods",
      );
    return plugin as TerminalPlugin;
  } catch (error) {
    throw new Error(
      `Unable to initialize ${commandName}: ${error instanceof Error ? error.message : String(error)}`,
      { cause: error },
    );
  }
}
