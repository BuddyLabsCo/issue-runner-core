#!/usr/bin/env node
import { readFileSync, realpathSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import { cac } from "cac";
import { initializeProject, loadProject } from "./config.ts";
import { AuditLog } from "./audit.ts";
import { hashRunInput } from "./recovery.ts";
import { GitHubTracker } from "./adapters/github-tracker.ts";
import { GitHubCodeHost } from "./adapters/github-code-host.ts";
import { LocalGitWorkspace } from "./adapters/git-workspace.ts";
import { loadTerminalPlugin } from "./adapters/terminal-plugin.ts";
import { TerminalOperator } from "./adapters/terminal.ts";
import type {
  Tracker,
  CodeHost,
  GitWorkspace,
  Clock,
  OperatorIO,
} from "./run/contracts.ts";
import type { TerminalPlugin } from "./terminal.ts";
import { runProject, type RunOptions, type RunSummary } from "./run/run.ts";
import { OperatorCancelled, supervisedAuditWrite } from "./run/operations.ts";

export interface CliDependencies {
  launchDirectory: string;
  env: Record<string, string | undefined>;
  operator: OperatorIO;
  clock?: Clock;
  tracker?: Tracker;
  codeHost?: CodeHost;
  gitWorkspace?: GitWorkspace;
  terminalPlugin?: TerminalPlugin;
  signal?: AbortSignal;
}

export interface CliResult {
  exitCode: number;
  summary: RunSummary;
  logPath: string | null;
}

const usage = `usage: issue-runner <command> [options]

Commands:
  init --project <project-key>  Create config.yaml and three Project prompts
  run --project <project-key> --env <name> (--parent <number> | --issue [<number>] | --document)

Project configuration: <launch directory>/<project-key>/config.yaml
Edit <project-key>/config.yaml and prompts/ before the first Run.
Install Core and the selected plugin globally in the same npm environment.
Run issue-runner run --help for scope constraints.`;

const runHelp = `usage: issue-runner run --project <project-key> --env <name> (--parent <number> | --issue [<number>] | --document)

Exactly one of --parent, --issue, or --document is required.
--issue without a number uses the configured issueList.
--no-auto-merge applies only to --issue <number> or --document, and accepts no value.
--env <name> selects the globally installed issue-runner-<name> plugin.
--issue runs selected Issues through verified implementation, independent Review,
and required fixes in their original native conversations.
Runner owns publication and integration after verification.
--no-auto-merge retains CI-ready unmerged work and exits nonzero.

Example: issue-runner run --project my-project --env herdr --parent 42`;

const initHelp = `usage: issue-runner init --project <project-key>

Creates <launch directory>/<project-key>/config.yaml and:
  prompts/implement.md
  prompts/review.md
  prompts/documentation.md

Project keys name one child using letters, digits, dot, underscore, or hyphen.
Existing destinations are refused. No credentials or plugin are needed.
Replace repository, checkout, targetBranch, tracker.runnerAccount, and every
Agent start/resume command. Edit the three repository-specific prompts.
Set the credentials named by tracker.tokenEnv and codeHost.tokenEnv.
Install Core and the selected terminal plugin globally in the same npm environment.
Then run issue-runner run --project <project-key> --env <name> --parent <number>.`;

function result(
  exitCode: number,
  project = "unknown",
  reasons: string[] = [],
): CliResult {
  return {
    exitCode,
    summary: {
      outcome: exitCode === 0 ? "no_work" : "failed",
      project,
      parentTicket: 0,
      targetBranch: "unresolved",
      reasons,
    },
    logPath: null,
  };
}

function parseArguments(argv: string[]): RunOptions {
  const cli = cac("issue-runner");
  cli
    .command("run")
    .option("--project <project>", "Project key")
    .option("--env <name>", "Terminal environment")
    .option("--parent <ticket>", "Parent Ticket number")
    .option("--issue [ticket]", "Standalone Issue number")
    .option("--document", "Documentation Maintenance")
    .option("--auto-merge", "Merge after CI readiness")
    .option("--no-auto-merge", "Retain CI-ready work")
    .action(() => undefined);
  cli.parse(["node", "issue-runner", ...argv]);
  const options = cli.options as Record<string, unknown>;
  if (
    cli.args.length ||
    typeof options.project !== "string" ||
    typeof options.env !== "string" ||
    !/^[a-z0-9]+(?:-[a-z0-9]+)*$/u.test(options.env)
  )
    throw new Error(
      "run requires --project and a valid --env name (lowercase letters, digits, hyphens)",
    );
  const selectors = [
    options.parent !== undefined,
    options.issue !== undefined,
    options.document === true,
  ];
  if (selectors.filter(Boolean).length !== 1) throw new Error(runHelp);
  if (argv.includes("--auto-merge") && argv.includes("--no-auto-merge"))
    throw new Error("auto-merge flags are mutually exclusive");
  if (typeof options.autoMerge !== "boolean")
    throw new Error("auto-merge flags do not accept a value");
  const ticket = (value: unknown): number | undefined => {
    if (value === undefined || value === true) return undefined;
    const number = Number(value);
    if (!Number.isSafeInteger(number) || number <= 0)
      throw new Error("a positive Parent Ticket or issue number is required");
    return number;
  };
  const parentTicket = ticket(options.parent);
  const issueTicket = ticket(options.issue);
  if (selectors[0] && parentTicket === undefined)
    throw new Error("a Parent Ticket number is required");
  if (
    (argv.includes("--auto-merge") || argv.includes("--no-auto-merge")) &&
    issueTicket === undefined &&
    !selectors[2]
  )
    throw new Error(
      "auto-merge flags require a value-bearing --issue or --document",
    );
  return {
    project: options.project,
    environment: options.env,
    selector: selectors[0] ? "parent" : selectors[1] ? "issue" : "document",
    ...(parentTicket === undefined ? {} : { parentTicket }),
    ...(issueTicket === undefined ? {} : { issueTicket }),
    autoMerge: options.autoMerge,
  };
}

export async function executeCli(
  argv: string[],
  dependencies: CliDependencies,
): Promise<CliResult> {
  const command = argv[0];
  if (command === "--version" || command === "-v") {
    const manifest = JSON.parse(
      readFileSync(
        path.join(import.meta.dirname, "..", "package.json"),
        "utf8",
      ),
    ) as { version: string };
    dependencies.operator.write(manifest.version);
    return result(0);
  }
  if (
    !command ||
    command === "--help" ||
    command === "-h" ||
    (["run", "init"].includes(command) &&
      argv.some((arg) => arg === "--help" || arg === "-h"))
  ) {
    dependencies.operator.write(
      command === "run" ? runHelp : command === "init" ? initHelp : usage,
    );
    return result(0);
  }
  if (command === "init") {
    try {
      const cli = cac("issue-runner");
      cli
        .command("init")
        .option("--project <project>", "Project key")
        .action(() => undefined);
      cli.parse(["node", "issue-runner", ...argv]);
      const { project } = cli.options as { project?: unknown };
      if (typeof project !== "string" || cli.args.length > 0)
        throw new Error("usage: issue-runner init --project <project-key>");
      const directory = await initializeProject(
        dependencies.launchDirectory,
        project,
      );
      dependencies.operator.write(
        `Initialized Project at ${directory}. Edit config.yaml and prompts/, set tokenEnv credentials, then run issue-runner run --project ${project} --env <name> --parent <number>.`,
      );
      return result(0, project, ["Project initialized"]);
    } catch (error) {
      dependencies.operator.write(
        `Startup failed: ${error instanceof Error ? error.message : String(error)}`,
      );
      return result(1, "unknown", [
        error instanceof Error ? error.message : String(error),
      ]);
    }
  }
  if (command === "run") return executeRun(argv, dependencies);
  dependencies.operator.write(`Startup failed: ${usage}`);
  return result(1, "unknown", [usage]);
}

export async function executeRun(
  argv: string[],
  dependencies: CliDependencies,
): Promise<CliResult> {
  let project = "unknown";
  let logPath: string | null = null;
  let parentTicket = 0;
  let targetBranch = "unresolved";
  let summary: RunSummary | undefined;
  try {
    dependencies.signal?.throwIfAborted();
    const options = parseArguments(argv);
    project = options.project;
    parentTicket = options.parentTicket ?? options.issueTicket ?? 0;
    const loaded = await loadProject(
      dependencies.launchDirectory,
      project,
      dependencies.env,
      {
        ...(options.selector === "document"
          ? { requireDocumentationMaintenance: true }
          : {}),
      },
    );
    if (
      options.selector === "issue" &&
      options.issueTicket === undefined &&
      !loaded.config.issueList.length
    )
      throw new Error("issueList must not be empty for value-less --issue");
    targetBranch = loaded.config.targetBranch ?? "unresolved";
    const terminalPlugin =
      dependencies.terminalPlugin ??
      (await loadTerminalPlugin(options.environment));
    if (
      typeof terminalPlugin.createTab !== "function" ||
      typeof terminalPlugin.submitText !== "function" ||
      typeof terminalPlugin.closeTab !== "function"
    )
      throw new Error(
        "Terminal plugin must implement createTab, submitText, and closeTab",
      );
    dependencies.signal?.throwIfAborted();
    const clock = dependencies.clock ?? {
      now: () => new Date(),
      sleep: (ms: number, signal = dependencies.signal) =>
        delay(ms, undefined, signal ? { signal } : {}),
    };
    const timestamp = clock.now().toISOString();
    const runId = randomUUID();
    const audit = new AuditLog(
      loaded.directory,
      timestamp,
      parentTicket,
      runId,
      [loaded.trackerToken, loaded.codeHostToken],
    );
    await supervisedAuditWrite(
      () => audit.create(),
      dependencies.operator,
      dependencies.signal,
    );
    logPath = audit.path;
    dependencies.operator.write(`${project}: workflow sessionid=n/a`);
    const runSummary = await runProject(
      options,
      loaded,
      dependencies.tracker ?? new GitHubTracker(loaded.trackerToken),
      dependencies.codeHost ?? new GitHubCodeHost(loaded.codeHostToken),
      {
        audit,
        runId,
        inputHash: hashRunInput(
          argv,
          readFileSync(path.join(loaded.directory, "config.yaml")),
        ),
        clock,
        operator: dependencies.operator,
        git:
          dependencies.gitWorkspace ??
          new LocalGitWorkspace(loaded.codeHostToken),
        terminal: terminalPlugin,
        ...(dependencies.signal === undefined
          ? {}
          : { signal: dependencies.signal }),
      },
    );
    summary = runSummary;
    targetBranch = runSummary.targetBranch;
    for (const ticket of runSummary.tickets ?? [])
      dependencies.operator.write(
        `Issue #${ticket.ticket} ${ticket.kind}: ${ticket.status} PR=${ticket.pullRequest === null ? "-" : `#${ticket.pullRequest}`} ${ticket.detail.replace(/\s+/gu, " ").trim()}`,
      );
    if (!dependencies.signal?.aborted)
      await supervisedAuditWrite(
        () =>
          audit.append({
            timestamp: clock.now().toISOString(),
            runId,
            project,
            parentTicket: runSummary.parentTicket,
            phase: "complete",
            operation: "run",
            target: runSummary.targetBranch,
            attempt: 1,
            result: runSummary.outcome,
            error: null,
          }),
        dependencies.operator,
        dependencies.signal,
      );
    dependencies.operator.write(
      `${project}: ${runSummary.outcome} targetBranch=${runSummary.targetBranch}${runSummary.reasons.length ? `: ${runSummary.reasons.join("; ")}` : ""}`,
    );
    return {
      exitCode: ["succeeded", "no_work"].includes(runSummary.outcome) ? 0 : 1,
      summary: runSummary,
      logPath: audit.path,
    };
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    const cancelled =
      error instanceof OperatorCancelled ||
      dependencies.signal?.aborted === true;
    dependencies.operator.write(
      `${logPath ? "Run" : "Startup"} ${cancelled ? "cancelled" : "failed"}: ${reason.replace(/\s+/gu, " ").trim()}`,
    );
    return {
      exitCode: 1,
      summary: {
        ...summary,
        outcome: cancelled ? "cancelled" : "failed",
        project,
        parentTicket,
        targetBranch,
        reasons: [...(summary?.reasons ?? []), reason],
      },
      logPath,
    };
  }
}

function isDirectExecution(): boolean {
  const entry = process.argv[1];
  if (entry === undefined) return false;
  try {
    return realpathSync(entry) === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
}

if (isDirectExecution()) {
  const controller = new AbortController();
  const cancel = () => controller.abort();
  process.once("SIGINT", cancel);
  process.once("SIGTERM", cancel);
  try {
    const result = await executeCli(process.argv.slice(2), {
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
