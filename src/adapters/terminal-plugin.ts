import { realpath } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { terminalContractVersion, type TerminalPlugin } from "../terminal.ts";

export async function loadTerminalPlugin(
  environment: string,
): Promise<TerminalPlugin> {
  if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/u.test(environment))
    throw new Error(
      "Invalid --env name; use lowercase letters, digits, and hyphens",
    );
  const name = `issue-runner-${environment}`;
  try {
    const core = await realpath(
      fileURLToPath(new URL("../../", import.meta.url)),
    );
    const sibling = await realpath(path.join(path.dirname(core), name));
    if (path.dirname(sibling) !== path.dirname(core))
      throw new Error(
        "selected package must be a sibling of the executing Core package",
      );
    // Node selects the public import entry; containment forbids local/cache fallbacks.
    const entry = await realpath(fileURLToPath(import.meta.resolve(name)));
    const relative = path.relative(sibling, entry);
    if (
      relative === ".." ||
      relative.startsWith(`..${path.sep}`) ||
      path.isAbsolute(relative)
    )
      throw new Error(
        "selected module is not the sibling of the executing Core package",
      );
    const module: unknown = await import(pathToFileURL(entry).href);
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
      typeof module.createTerminalPlugin !== "function" ||
      module.createTerminalPlugin.length !== 0
    )
      throw new Error(
        "plugin must export a zero-argument createTerminalPlugin factory",
      );
    const factory = module.createTerminalPlugin as () => Promise<unknown>;
    const plugin = await factory();
    if (
      typeof plugin !== "object" ||
      plugin === null ||
      !("createTab" in plugin) ||
      typeof plugin.createTab !== "function" ||
      !("submitText" in plugin) ||
      typeof plugin.submitText !== "function" ||
      !("closeTab" in plugin) ||
      typeof plugin.closeTab !== "function"
    )
      throw new Error(
        "factory must return createTab, submitText, and closeTab methods",
      );
    return plugin as TerminalPlugin;
  } catch (error) {
    throw new Error(
      `Unable to load ${name}: ${error instanceof Error ? error.message : String(error)}. Install a contract-v${terminalContractVersion} compatible ${name} globally in the same npm environment/prefix as issue-runner-core.`,
      { cause: error },
    );
  }
}
