import { execFile } from "node:child_process";
import { lstat, readFile, realpath, stat } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { fileURLToPath, pathToFileURL } from "node:url";
import type { CliOptions } from "../cli-entry.ts";
import {
  enhancementContractVersion,
  type EnhancementModule,
} from "../terminal.ts";

const execute = promisify(execFile);
const record = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);
const missing = (error: unknown) => record(error) && error.code === "ENOENT";

function contained(root: string, entry: string): boolean {
  const relative = path.relative(root, entry);
  return (
    relative !== "" &&
    relative !== ".." &&
    !relative.startsWith(`..${path.sep}`) &&
    !path.isAbsolute(relative)
  );
}

async function globalModules(
  options: Pick<
    CliOptions,
    "commandName" | "terminalPackageRoot" | "terminalCliEntry"
  >,
): Promise<string> {
  const { commandName, terminalPackageRoot, terminalCliEntry } = options;
  if (
    !/^[a-zA-Z0-9._-]+$/.test(commandName) ||
    !path.isAbsolute(terminalPackageRoot) ||
    !path.isAbsolute(terminalCliEntry)
  )
    throw new Error(
      "terminal installation requires an executable name and absolute package/CLI paths",
    );
  const root = await realpath(terminalPackageRoot);
  const manifest: unknown = JSON.parse(
    await readFile(path.join(root, "package.json"), "utf8"),
  );
  if (
    !record(manifest) ||
    typeof manifest.name !== "string" ||
    !/^(?:@[a-z0-9._-]+\/)?[a-z0-9._-]+$/.test(manifest.name)
  )
    throw new Error("invalid terminal package identity");
  const modules = manifest.name.startsWith("@")
    ? path.dirname(path.dirname(root))
    : path.dirname(root);
  if (
    path.basename(modules) !== "node_modules" ||
    path.join(modules, manifest.name) !== root
  )
    throw new Error(
      "terminal package identity must match its global installation",
    );
  const bin =
    typeof manifest.bin === "string" &&
    commandName === manifest.name.split("/").at(-1)
      ? manifest.bin
      : record(manifest.bin)
        ? manifest.bin[commandName]
        : undefined;
  if (typeof bin !== "string" || !contained(root, path.resolve(root, bin)))
    throw new Error("terminal must declare a contained executable");
  const cli = await realpath(path.resolve(root, bin));
  if (
    !contained(root, cli) ||
    !(await stat(cli)).isFile() ||
    !contained(root, path.resolve(terminalCliEntry)) ||
    (await realpath(terminalCliEntry)) !== cli
  )
    throw new Error(
      "terminal CLI entry must match its contained declared executable",
    );
  const launchers = [path.join(path.dirname(modules), `${commandName}.cmd`)];
  if (path.basename(path.dirname(modules)) === "lib")
    launchers.push(path.resolve(modules, "../../bin", commandName));
  for (const launcher of launchers) {
    try {
      let destination = launcher;
      if (launcher.endsWith(".cmd")) {
        const shim = await realpath(launcher);
        if (path.dirname(shim) !== path.dirname(launcher))
          throw new Error("terminal launcher escapes its global prefix");
        const match = /"%(?:~dp0|dp0%)\\([^"]+?)"\s+%\*/.exec(
          await readFile(shim, "utf8"),
        );
        if (!match) continue;
        destination = path.resolve(
          path.dirname(launcher),
          match[1]!.replaceAll("\\", path.sep),
        );
      }
      if ((await realpath(destination)) === cli) return modules;
    } catch (error) {
      if (!missing(error)) throw error;
    }
  }
  throw new Error("terminal requires a matching same-prefix global launcher");
}

export async function discoverEnhancements(
  options: Pick<
    CliOptions,
    "commandName" | "terminalPackageRoot" | "terminalCliEntry"
  >,
  agents: readonly string[],
  report: (message: string) => void,
): Promise<Record<string, EnhancementModule>> {
  const modules = await globalModules(options);
  const enhancements = Object.create(null) as Record<string, EnhancementModule>;
  for (const agent of new Set(agents)) {
    const name = `issue-runner-agent-${agent}`;
    if (name.length > 214 || !/^[a-z0-9._-]+$/.test(agent)) continue;
    const sibling = path.join(modules, name);
    try {
      await lstat(sibling);
    } catch (error) {
      if (missing(error)) continue;
      throw error;
    }
    try {
      const installed = await realpath(sibling);
      if (installed !== sibling)
        throw new Error("enhancement must be installed in the same npm prefix");
      // Node resolves import conditions from this prefix, independent of Core's nesting.
      const { stdout } = await execute(
        process.execPath,
        [
          "--input-type=module",
          "--eval",
          "process.stdout.write(import.meta.resolve(process.argv[1]))",
          name,
        ],
        { cwd: path.dirname(modules), timeout: 30_000 },
      );
      const entry = await realpath(fileURLToPath(stdout));
      if (!contained(installed, entry))
        throw new Error("enhancement entry escapes its installed package");
      if (!(await stat(entry)).isFile())
        throw new Error("enhancement entry must be a file");
      const module: unknown = await import(pathToFileURL(entry).href);
      if (
        !record(module) ||
        typeof module.contractVersion !== "number" ||
        !Number.isSafeInteger(module.contractVersion) ||
        module.contractVersion <= 0
      )
        throw new Error(
          "enhancement must export a positive integer contractVersion",
        );
      if (typeof module.createEnhancement !== "function")
        throw new Error("enhancement must export callable createEnhancement");
      if (module.contractVersion !== enhancementContractVersion) {
        report(
          `Skipping ${name}: enhancement contractVersion ${String(module.contractVersion)} is incompatible with ${enhancementContractVersion}; using base startup`,
        );
        continue;
      }
      enhancements[agent] = module as unknown as EnhancementModule;
    } catch (error) {
      throw new Error(
        `Unable to load ${name}: ${error instanceof Error ? error.message : String(error)}`,
        { cause: error },
      );
    }
  }
  return enhancements;
}
