/* eslint-disable @typescript-eslint/require-await -- Scripted external boundaries. */
import { promptAssignment } from "./prompt-assignment.ts";
import { rm } from "node:fs/promises";
import type { TestContext } from "node:test";
import type { GitWorkspace, Ticket } from "../../src/run/contracts.ts";
import { agent, validConfig } from "./cli-project.ts";
import { parentDeliveryRun } from "./parent-run.ts";
import { publish } from "./implementation-run.ts";

export const batchDocumentationConfig = {
  ...validConfig,
  agents: { ...validConfig.agents, documentation: agent },
  workflow: { review: false, docMaintainTriggerLabel: "Docs" },
  maintenanceTicket: {
    title: "Maintain docs",
    body: "Update project documentation",
    label: "doc-maintain",
  },
};

export const documentationNoChange = {
  outcome: "no_change",
  summary: "Documentation is current",
  commits: [],
  findings_file: null,
};

export async function batchDocumentationRun(
  t: TestContext,
  children: Ticket[],
  config: Omit<typeof batchDocumentationConfig, "issueList"> & {
    issueList: number[];
  } = batchDocumentationConfig,
) {
  const fixture = await parentDeliveryRun(t, children, config);
  const maintenance: Ticket[] = [];
  const events: string[] = [];
  const cleanup: string[] = [];
  const state: {
    onDocument: (file: string, commit: () => Promise<void>) => Promise<void>;
  } = {
    onDocument: (file: string) => publish(file, documentationNoChange),
  };
  const tracker = fixture.dependencies.tracker;
  const getTicket = tracker.getTicket.bind(tracker);
  const closeTicket = tracker.closeTicket.bind(tracker);
  tracker.listLabelsPage = async () => ({
    labels: ["doc-maintain"],
    nextPage: null,
  });
  tracker.createMaintenanceTicket = async (_repository, title, body, label) => {
    const ticket: Ticket = {
      number: 100 + maintenance.length,
      repository: "owner/repo",
      state: "open",
      stateReason: null,
      title,
      body,
      labels: [label],
      assignees: [],
    };
    maintenance.push(ticket);
    events.push(`maintenance:${ticket.number}`);
    return structuredClone(ticket);
  };
  tracker.getTicket = async (repository, number) => {
    const ticket = maintenance.find((ticket) => ticket.number === number);
    return ticket ? structuredClone(ticket) : getTicket(repository, number);
  };
  tracker.closeTicket = async (repository, number) => {
    events.push(`close:${number}`);
    const ticket = maintenance.find((ticket) => ticket.number === number);
    if (ticket) {
      ticket.state = "closed";
      ticket.stateReason = "completed";
    } else await closeTicket(repository, number);
  };
  Object.assign(fixture.dependencies.gitWorkspace, {
    async cleanupWorktree(
      input: Parameters<GitWorkspace["cleanupWorktree"]>[0],
    ) {
      cleanup.push(input.worktree);
      await rm(input.worktree, { recursive: true });
    },
  });
  const submit = fixture.dependencies.terminalPlugin.submitText.bind(
    fixture.dependencies.terminalPlugin,
  );
  fixture.dependencies.terminalPlugin.submitText = async (tab, text) => {
    if (text.startsWith("Documentation assignment\n")) {
      const assignment = promptAssignment(text) as { path: string };
      events.push("document");
      await state.onDocument(assignment.path, () =>
        submit(
          tab,
          text.replace(
            /^Documentation assignment\n/u,
            "Implementation assignment\n",
          ),
        ),
      );
    } else {
      if (text.startsWith("Implementation assignment\n"))
        events.push("implement");
      await submit(tab, text);
    }
  };
  return { ...fixture, maintenance, events, cleanup, state };
}
