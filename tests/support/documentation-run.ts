/* eslint-disable @typescript-eslint/require-await -- Scripted external boundaries. */
import assert from "node:assert/strict";
import { rm } from "node:fs/promises";
import type { TestContext } from "node:test";
import { executeCli } from "../../src/cli.ts";
import { agent, validConfig } from "./cli-project.ts";
import { integrationRun } from "./integration-run.ts";

export const documentCommand = [
  "run",
  "--project",
  "demo",
  "--env",
  "fake",
  "--document",
];

export async function documentationRun(
  t: TestContext,
  ticketClosure = "runner",
) {
  const config = {
    ...validConfig,
    ticketClosure,
    agents: {
      ...validConfig.agents,
      documentation: {
        ...agent,
        start: "document-cli",
        resume: 'document-cli --resume "{sessionref}"',
      },
    },
    workflow: { review: true },
    maintenanceTicket: {
      title: "Maintain docs",
      body: "Update project documentation",
      label: "doc-maintain",
    },
  };
  const fixture = await integrationRun(t, config);
  fixture.state.ticket.labels = ["doc-maintain"];
  const maintenance = {
    creates: 0,
    labels: [] as string[],
    cleanup: [] as string[],
  };
  Object.assign(fixture.dependencies.tracker, {
    async createLabel(_repository: string, label: string) {
      maintenance.labels.push(label);
    },
    async listLabelsPage() {
      return { labels: maintenance.labels, nextPage: null };
    },
    async createMaintenanceTicket(
      _repository: string,
      title: string,
      body: string,
      label: string,
    ) {
      assert.equal(title, config.maintenanceTicket.title);
      assert.equal(body, config.maintenanceTicket.body);
      assert.equal(label, "doc-maintain");
      fixture.state.ticket.number = 50 + maintenance.creates;
      fixture.state.ticket.state = "open";
      fixture.state.ticket.stateReason = null;
      fixture.state.evidence.commits = [];
      maintenance.creates++;
      return structuredClone(fixture.state.ticket);
    },
    async getParent() {
      assert.fail("documentation must not select a business Issue");
    },
    async listChildrenPage() {
      assert.fail("documentation must not discover business Issues");
    },
    async addAssignee() {
      assert.fail("maintenance is unassigned");
    },
    async addLabel() {
      assert.fail("maintenance needs no Reservation");
    },
  });
  Object.assign(fixture.dependencies.gitWorkspace, {
    async cleanupWorktree(input: { worktree: string }) {
      maintenance.cleanup.push(input.worktree);
      await rm(input.worktree, { recursive: true });
    },
  });
  const submit = fixture.dependencies.terminalPlugin.submitText.bind(
    fixture.dependencies.terminalPlugin,
  );
  fixture.dependencies.terminalPlugin.submitText = (tab, text, chord) =>
    submit(
      tab,
      text
        .replace(/^Documentation assignment\n/u, "Implementation assignment\n")
        .replace(
          /^Correct the documentation handoff:/u,
          "Correct the implementation handoff:",
        ),
      chord,
    );
  return {
    ...fixture,
    maintenance,
    run: (flags: string[] = []) =>
      executeCli([...documentCommand, ...flags], fixture.dependencies),
  };
}
