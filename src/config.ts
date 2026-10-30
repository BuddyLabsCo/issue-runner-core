import { readFile, copyFile, mkdir } from "node:fs/promises";
import { constants } from "node:fs";
import path from "node:path";
import { parse } from "yaml";

import type { RetryPolicy } from "./run/contracts.ts";
type TicketClosurePolicy = "runner" | "code_host";

const documentationConfigurationError =
  "Documentation Maintenance is enabled; supply agents.documentation and prompts/documentation.md";
const reviewConfigurationError =
  "Review is enabled; supply agents.review and prompts/review.md";

export interface AgentConfig {
  start: string;
  resume: string;
  submitKey?: string;
  options?: Record<string, unknown>;
}

export interface ProjectConfig {
  repository: string;
  checkout: string;
  issueList: number[];
  maxBatchSize: number;
  targetBranch?: string;
  tracker: {
    tokenEnv: string;
    runnerAccount: string;
    reservationLabel: string;
  };
  codeHost: { tokenEnv: string; adminMerge: boolean };
  workflow: {
    review: boolean;
    maxReviewRounds?: number;
    docMaintainTriggerLabel: string;
  };
  agents: {
    implement: AgentConfig;
    review?: AgentConfig;
    ciRepair: AgentConfig;
    conflictRepair: AgentConfig;
    documentation?: AgentConfig;
  };
  timeouts: {
    agentMinutes: number;
    agentIdleMinutes: number;
    requiredChecksMinutes: number;
    mergeQueueMinutes: number;
  };
  ticketClosure: TicketClosurePolicy;
  operationRetry: number;
  agentRetry: number;
  operationRetryDelay: number[];
  agentRetryDelay: number[];
  maintenanceTicket: { title: string; body: string; label: string };
}

export interface LoadedProject {
  config: ProjectConfig;
  directory: string;
  trackerToken: string;
  codeHostToken: string;
}

function record(value: unknown, name: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`${name} must be an object`);
  }
  return value as Record<string, unknown>;
}

function text(value: unknown, name: string): string {
  if (typeof value !== "string" || value.trim().length === 0)
    throw new Error(`${name} must be set`);
  return value;
}

function knownFields(
  input: Record<string, unknown>,
  fields: string[],
  name: string,
): void {
  const unknown = Object.keys(input).find((field) => !fields.includes(field));
  if (unknown) throw new Error(`${name} contains unknown field ${unknown}`);
}

function positive(value: unknown, name: string): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) {
    throw new Error(`${name} must be a positive number`);
  }
  return value;
}

function nonNegativeInteger(value: unknown, name: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
    throw new Error(`${name} must be a non-negative integer`);
  }
  return value;
}

function issueList(value: unknown): number[] {
  if (!Array.isArray(value)) throw new Error("issueList must be an array");
  const numbers = value.map((item) => {
    if (!Number.isSafeInteger(item) || (item as number) <= 0) {
      throw new Error("issueList entries must be positive safe integers");
    }
    return item as number;
  });
  if (new Set(numbers).size !== numbers.length) {
    throw new Error("issueList entries must be unique");
  }
  return numbers.sort((left, right) => left - right);
}

function retryDelays(value: unknown, name: string): number[] {
  const delays = Array.isArray(value) ? (value as unknown[]) : undefined;
  if (
    delays === undefined ||
    delays.length === 0 ||
    delays.some(
      (item) => typeof item !== "number" || !Number.isFinite(item) || item <= 0,
    )
  ) {
    throw new Error(`${name} must be a non-empty array of positive numbers`);
  }
  return delays.map((item) => item as number);
}

function switchValue(
  value: unknown,
  name: string,
  defaultValue = true,
): boolean {
  if (value === undefined) return defaultValue;
  if (typeof value !== "boolean") throw new Error(`${name} must be a boolean`);
  return value;
}

function agent(value: unknown, name: string): AgentConfig {
  const input = record(value, name);
  knownFields(input, ["start", "resume", "submitKey", "options"], name);
  const start = text(input.start, `${name}.start`);
  const resume = text(input.resume, `${name}.resume`);
  if (!resume.includes("{sessionref}"))
    throw new Error(
      `${name}.resume must contain the exact {sessionref} placeholder`,
    );
  const submitKey =
    input.submitKey === undefined
      ? undefined
      : text(input.submitKey, `${name}.submitKey`);
  const options =
    input.options === undefined
      ? undefined
      : record(input.options, `${name}.options`);
  if (options && "submitKey" in options)
    throw new Error(`${name}.submitKey belongs outside options`);
  return {
    start,
    resume,
    ...(submitKey === undefined ? {} : { submitKey }),
    ...(options === undefined ? {} : { options }),
  };
}

function parseConfig(
  value: unknown,
  options: { requireDocumentationMaintenance?: boolean } = {},
): ProjectConfig {
  const input = record(value, "config");
  knownFields(
    input,
    [
      "repository",
      "checkout",
      "issueList",
      "maxBatchSize",
      "targetBranch",
      "tracker",
      "codeHost",
      "workflow",
      "agents",
      "timeouts",
      "ticketClosure",
      "operationRetry",
      "agentRetry",
      "operationRetryDelay",
      "agentRetryDelay",
      "maintenanceTicket",
    ],
    "config",
  );
  const tracker = record(input.tracker, "tracker");
  const codeHost = record(input.codeHost, "codeHost");
  const agents = record(input.agents, "agents");
  knownFields(
    tracker,
    ["tokenEnv", "runnerAccount", "reservationLabel"],
    "tracker",
  );
  knownFields(codeHost, ["tokenEnv", "adminMerge"], "codeHost");
  knownFields(
    agents,
    ["implement", "review", "ciRepair", "conflictRepair", "documentation"],
    "agents",
  );
  const workflow =
    input.workflow === undefined ? {} : record(input.workflow, "workflow");
  const unknownWorkflowField = Object.keys(workflow).find(
    (name) =>
      !["review", "maxReviewRounds", "docMaintainTriggerLabel"].includes(name),
  );
  if (unknownWorkflowField) {
    throw new Error(`workflow contains unknown field ${unknownWorkflowField}`);
  }
  const maxReviewRounds = workflow.maxReviewRounds;
  if (
    maxReviewRounds !== undefined &&
    (typeof maxReviewRounds !== "number" ||
      !Number.isSafeInteger(maxReviewRounds) ||
      maxReviewRounds <= 0)
  ) {
    throw new Error("workflow.maxReviewRounds must be a positive integer");
  }
  const timeouts = record(input.timeouts, "timeouts");
  knownFields(
    timeouts,
    [
      "agentMinutes",
      "agentIdleMinutes",
      "requiredChecksMinutes",
      "mergeQueueMinutes",
    ],
    "timeouts",
  );
  const retryPolicy: RetryPolicy = {
    operationRetry: nonNegativeInteger(input.operationRetry, "operationRetry"),
    agentRetry: nonNegativeInteger(input.agentRetry, "agentRetry"),
    operationRetryDelay: retryDelays(
      input.operationRetryDelay,
      "operationRetryDelay",
    ),
    agentRetryDelay: retryDelays(input.agentRetryDelay, "agentRetryDelay"),
  };
  const repository = text(input.repository, "repository");
  const configuredIssueList = issueList(input.issueList);
  const maxBatchSize = nonNegativeInteger(input.maxBatchSize, "maxBatchSize");
  if (maxBatchSize === 0)
    throw new Error("maxBatchSize must be a positive safe integer");
  if (!/^[^/\s]+\/[^/\s]+$/u.test(repository))
    throw new Error("repository must be owner/repo");
  const checkout = text(input.checkout, "checkout");
  if (!path.isAbsolute(checkout)) throw new Error("checkout must be absolute");
  if (typeof codeHost.adminMerge !== "boolean")
    throw new Error("codeHost.adminMerge is required");
  if (input.ticketClosure !== "runner" && input.ticketClosure !== "code_host") {
    throw new Error("ticketClosure is unsupported");
  }
  if (
    workflow.docMaintainTriggerLabel !== undefined &&
    typeof workflow.docMaintainTriggerLabel !== "string"
  ) {
    throw new Error("workflow.docMaintainTriggerLabel must be a string");
  }
  const docMaintainTriggerLabel =
    typeof workflow.docMaintainTriggerLabel === "string"
      ? workflow.docMaintainTriggerLabel.trim()
      : "";
  const documentationRequired =
    options.requireDocumentationMaintenance === true ||
    docMaintainTriggerLabel.length > 0;
  const documentation =
    agents.documentation === undefined
      ? undefined
      : agent(agents.documentation, "agents.documentation");
  const reviewEnabled = switchValue(workflow.review, "workflow.review");
  const review =
    agents.review === undefined
      ? undefined
      : agent(agents.review, "agents.review");
  if (reviewEnabled && review === undefined) {
    throw new Error(reviewConfigurationError);
  }
  if (documentationRequired && documentation === undefined) {
    throw new Error(documentationConfigurationError);
  }
  const maintenanceTicket =
    input.maintenanceTicket === undefined
      ? {}
      : record(input.maintenanceTicket, "maintenanceTicket");
  knownFields(
    maintenanceTicket,
    ["title", "body", "label"],
    "maintenanceTicket",
  );
  if (documentationRequired) {
    text(maintenanceTicket.title, "maintenanceTicket.title");
    text(maintenanceTicket.body, "maintenanceTicket.body");
    text(maintenanceTicket.label, "maintenanceTicket.label");
  }

  return {
    repository,
    checkout,
    issueList: configuredIssueList,
    maxBatchSize,
    ...(input.targetBranch === undefined
      ? {}
      : { targetBranch: text(input.targetBranch, "targetBranch") }),
    tracker: {
      tokenEnv: text(tracker.tokenEnv, "tracker.tokenEnv"),
      runnerAccount: text(tracker.runnerAccount, "tracker.runnerAccount"),
      reservationLabel: text(
        tracker.reservationLabel,
        "tracker.reservationLabel",
      ),
    },
    codeHost: {
      tokenEnv: text(codeHost.tokenEnv, "codeHost.tokenEnv"),
      adminMerge: codeHost.adminMerge,
    },
    workflow: {
      review: reviewEnabled,
      ...(maxReviewRounds === undefined ? {} : { maxReviewRounds }),
      docMaintainTriggerLabel,
    },
    agents: {
      implement: agent(agents.implement, "agents.implement"),
      ...(review === undefined ? {} : { review }),
      ciRepair: agent(agents.ciRepair, "agents.ciRepair"),
      conflictRepair: agent(agents.conflictRepair, "agents.conflictRepair"),
      ...(documentation === undefined ? {} : { documentation }),
    },
    timeouts: {
      agentMinutes: positive(timeouts.agentMinutes, "timeouts.agentMinutes"),
      agentIdleMinutes: positive(
        timeouts.agentIdleMinutes === undefined
          ? 10
          : timeouts.agentIdleMinutes,
        "timeouts.agentIdleMinutes",
      ),
      requiredChecksMinutes: positive(
        timeouts.requiredChecksMinutes,
        "timeouts.requiredChecksMinutes",
      ),
      mergeQueueMinutes: positive(
        timeouts.mergeQueueMinutes,
        "timeouts.mergeQueueMinutes",
      ),
    },
    ticketClosure: input.ticketClosure,
    ...retryPolicy,
    maintenanceTicket: {
      title: documentationRequired
        ? text(maintenanceTicket.title, "maintenanceTicket.title")
        : "",
      body: documentationRequired
        ? text(maintenanceTicket.body, "maintenanceTicket.body")
        : "",
      label: documentationRequired
        ? text(maintenanceTicket.label, "maintenanceTicket.label")
        : "",
    },
  };
}

export async function loadProject(
  launchDirectory: string,
  projectKey: string,
  env: Record<string, string | undefined>,
  options: { requireDocumentationMaintenance?: boolean } = {},
): Promise<LoadedProject> {
  const directory = resolveProjectDirectory(launchDirectory, projectKey);
  const configPath = path.join(directory, "config.yaml");
  let value: unknown;
  try {
    value = parse(await readFile(configPath, "utf8"));
  } catch (error) {
    throw new Error(
      `failed to load ${configPath}: ${error instanceof Error ? error.message : String(error)}`,
      { cause: error },
    );
  }
  const config = parseConfig(value, options);
  if (
    (
      await readFile(path.join(directory, "prompts", "implement.md"), "utf8")
    ).trim() === ""
  ) {
    throw new Error("implement.md must not be empty");
  }
  if (
    options.requireDocumentationMaintenance === true ||
    config.workflow.docMaintainTriggerLabel.length > 0
  ) {
    try {
      if (
        (
          await readFile(
            path.join(directory, "prompts", "documentation.md"),
            "utf8",
          )
        ).trim() === ""
      ) {
        throw new Error("empty prompt");
      }
    } catch {
      throw new Error(documentationConfigurationError);
    }
  }
  if (config.workflow.review) {
    try {
      if (
        (
          await readFile(path.join(directory, "prompts", "review.md"), "utf8")
        ).trim() === ""
      ) {
        throw new Error("empty prompt");
      }
    } catch {
      throw new Error(reviewConfigurationError);
    }
  }
  const trackerToken = env[config.tracker.tokenEnv];
  const codeHostToken = env[config.codeHost.tokenEnv];
  if (!trackerToken?.trim())
    throw new Error(`missing credential ${config.tracker.tokenEnv}`);
  if (!codeHostToken?.trim())
    throw new Error(`missing credential ${config.codeHost.tokenEnv}`);
  return { config, directory, trackerToken, codeHostToken };
}

// `--project` is a key for one child of the launch directory, never a path.
const projectKeyPattern = /^[A-Za-z0-9._-]+$/u;

export function resolveProjectDirectory(
  launchDirectory: string,
  projectKey: string,
): string {
  if (
    !projectKeyPattern.test(projectKey) ||
    projectKey === "." ||
    projectKey === ".."
  ) {
    throw new Error(
      `Invalid project key "${projectKey}"; use letters, digits, dot, underscore, or hyphen for a child of the launch directory`,
    );
  }
  const launch = path.resolve(launchDirectory);
  const directory = path.resolve(launch, projectKey);
  if (path.dirname(directory) !== launch) {
    throw new Error(
      `Invalid project key "${projectKey}"; it must resolve beneath ${launch}`,
    );
  }
  return directory;
}

const initializationFiles = [
  "config.yaml",
  "prompts/implement.md",
  "prompts/review.md",
  "prompts/documentation.md",
] as const;

function failureMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export async function initializeProject(
  launchDirectory: string,
  projectKey: string,
): Promise<string> {
  const directory = resolveProjectDirectory(launchDirectory, projectKey);
  try {
    // A non-recursive mkdir is the atomic existence check: it also refuses an
    // empty directory, a file, a symbolic link, and a destination created by a
    // concurrent Run instead of adopting any of them.
    await mkdir(directory);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST") {
      throw new Error(
        `Cannot initialize Project at ${directory}: the destination already exists`,
        { cause: error },
      );
    }
    throw new Error(
      `Initialization failed for ${directory}: ${failureMessage(error)}`,
      { cause: error },
    );
  }
  const assets = path.join(import.meta.dirname, "..", "templates");
  try {
    await mkdir(path.join(directory, "prompts"));
    for (const file of initializationFiles) {
      await copyFile(
        path.join(assets, file),
        path.join(directory, file),
        constants.COPYFILE_EXCL,
      );
    }
  } catch (error) {
    // Keep the files already written so the operator can inspect the failure.
    throw new Error(
      `Initialization failed for ${directory}: ${failureMessage(error)}; partial output was retained for inspection`,
      { cause: error },
    );
  }
  return directory;
}
