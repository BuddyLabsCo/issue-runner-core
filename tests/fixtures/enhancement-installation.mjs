import { mkdirSync, realpathSync, symlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

/** @param {string} file @param {unknown} value */
export function writeJson(file, value) {
  writeFileSync(file, JSON.stringify(value));
}

/**
 * @param {string} prefix
 * @param {"unix" | "windows" | "project" | "project-lib"} [layout]
 * @param {string} [name]
 */
export function terminalInstallation(
  prefix,
  layout = "windows",
  name = "generic-terminal",
) {
  mkdirSync(prefix, { recursive: true });
  prefix = realpathSync(prefix);
  const modules = join(
    prefix,
    ...(["unix", "project-lib"].includes(layout) ? ["lib"] : []),
    "node_modules",
  );
  const terminalPackageRoot = join(modules, name);
  const terminalCliEntry = join(terminalPackageRoot, "command.mjs");
  const commandName = "generic-terminal";
  mkdirSync(terminalPackageRoot, { recursive: true });
  writeJson(join(terminalPackageRoot, "package.json"), {
    name,
    type: "module",
    bin: { [commandName]: "command.mjs" },
  });
  writeFileSync(terminalCliEntry, "export {};\n");
  const launcher =
    layout === "unix"
      ? join(prefix, "bin", commandName)
      : join(prefix, `${commandName}.cmd`);
  if (layout === "unix") {
    mkdirSync(dirname(launcher), { recursive: true });
    symlinkSync(terminalCliEntry, launcher);
  } else if (layout === "windows") {
    writeFileSync(
      launcher,
      `@echo off\r\nnode "%dp0%\\node_modules\\${name.replaceAll("/", "\\")}\\command.mjs" %*\r\n`,
    );
  }
  return {
    prefix,
    modules,
    launcher,
    commandName,
    terminalPackageRoot,
    terminalCliEntry,
  };
}

export const genericEnhancement = `
export const contractVersion = 3;
export const events = [];
export async function createEnhancement(io, recover, context, config) {
  events.push(["factory", config]);
  return {
    async startMonitoring(ref) { events.push(["monitor", ref]); },
    async waitUntilReady() { return "discovered-native"; },
    onAssignment(assignment) { events.push(["assignment", assignment.expectedFile]); },
    async enhancementResume(id) { events.push(["resume", id]); },
    async stop() { events.push(["stop"]); },
  };
}
`;

/** @param {string} modules @param {string} [source] @param {string} [agent] */
export function installEnhancement(
  modules,
  source = genericEnhancement,
  agent = "custom-agent",
) {
  const root = join(modules, `issue-runner-agent-${agent}`);
  mkdirSync(root, { recursive: true });
  writeJson(join(root, "package.json"), {
    name: `issue-runner-agent-${agent}`,
    version: "99.0.0",
    type: "module",
    exports: { import: "./index.mjs" },
  });
  writeFileSync(join(root, "index.mjs"), source);
  return root;
}
