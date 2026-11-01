/* eslint-disable @typescript-eslint/require-await -- Scripted external boundaries. */
import assert from "node:assert/strict";
import test from "node:test";
import { GitHubTracker } from "../../src/adapters/github-tracker.ts";
import { documentationRun } from "../support/documentation-run.ts";
import { publish } from "../support/implementation-run.ts";

await test("GitHub documentation scans label pages, reconciles label creation, and creates an ordinary Maintenance Ticket", async (t) => {
  const fixture = await documentationRun(t);
  let labelled = false;
  let labelCreates = 0;
  let ticketCreates = 0;
  const pages: number[] = [];
  const tracker = new GitHubTracker("tracker-secret", async (args, options) => {
    assert.equal(options.token, "tracker-secret");
    if (args[2] === "GET") {
      assert.equal(args[3], "repos/owner/repo/labels");
      const page = Number(args.at(-1)!.slice("page=".length));
      pages.push(page);
      return JSON.stringify(
        page === 1
          ? Array.from({ length: 100 }, (_, index) => ({
              name: `other-${index}`,
            }))
          : labelled
            ? [{ name: "doc-maintain" }]
            : [],
      );
    }
    assert.equal(args[2], "POST");
    if (args[3] === "repos/owner/repo/labels") {
      assert.deepEqual(args.slice(4), ["-f", "name=doc-maintain"]);
      labelled = true;
      labelCreates++;
      throw new Error("lost label creation response");
    }
    assert.deepEqual(args, [
      "api",
      "--method",
      "POST",
      "repos/owner/repo/issues",
      "-f",
      "title=Maintain docs",
      "-f",
      "body=Update project documentation",
      "-f",
      "labels[]=doc-maintain",
    ]);
    ticketCreates++;
    return JSON.stringify({
      number: 50,
      state: "open",
      state_reason: null,
      title: "Maintain docs",
      body: "Update project documentation",
      html_url: "https://github.com/owner/repo/issues/50",
      labels: [{ name: "doc-maintain" }],
      assignees: [],
    });
  });
  Object.assign(fixture.dependencies.tracker, {
    createLabel: tracker.createLabel.bind(tracker),
    listLabelsPage: tracker.listLabelsPage.bind(tracker),
    createMaintenanceTicket: tracker.createMaintenanceTicket.bind(tracker),
  });
  fixture.state.onTask = async (file) => {
    fixture.state.evidence.changed = false;
    await publish(file, {
      outcome: "no_change",
      summary: "Current",
      commits: [],
      findings_file: null,
    });
  };
  assert.equal((await fixture.run()).summary.outcome, "succeeded");
  assert.deepEqual(pages, [1, 2, 1, 2]);
  assert.equal(labelCreates, 1);
  assert.equal(ticketCreates, 1);
  assert.equal(fixture.integrationState.closures, 1);
  assert.equal(fixture.publicationState.creations, 0);
});
