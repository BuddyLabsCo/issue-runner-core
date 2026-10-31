/* eslint-disable @typescript-eslint/require-await -- Scripted external boundaries. */
import assert from "node:assert/strict";
import { mkdir, readFile, readdir, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";

import { executeCli } from "../../src/cli.ts";
import { createProject, validConfig } from "../support/cli-project.ts";
import { createCliDependencies } from "../support/cli-dependencies.ts";

const command = [
  "run",
  "--project",
  "demo",
  "--env",
  "fake",
  "--issue",
  "50",
  "--no-auto-merge",
];
const commit = { sha: "b".repeat(40), message: "feat: implement the Issue" };

await test("one standalone implementation persists verified completion before closing its tab, without delivering the Issue", async (t) => {
  const { root, directory } = await createProject(t, {
    ...validConfig,
    workflow: { review: false },
  });
  const deps = createCliDependencies(root);
  const effects: string[] = [];
  let worktree = "";
  let branch = "";
  let probe: Record<string, unknown>;
  let handoff = "";
  const labels = ["ready-for-agent"];
  const assignees: string[] = [];
  const snapshot = async () => {
    const files = await readdir(path.join(directory, "recovery"));
    assert.equal(files.length, 1);
    return JSON.parse(
      await readFile(path.join(directory, "recovery", files[0]!), "utf8"),
    ) as Record<string, unknown>;
  };
  const dependencies = {
    ...deps,
    tracker: {
      ...deps.tracker,
      async getTicket() {
        return {
          number: 50,
          state: "open" as const,
          stateReason: null,
          title: "Implement the Issue",
          body: "Keep literal $& and Unicode: \u4f60\u597d",
          labels: [...labels],
          assignees: [...assignees],
        };
      },
      async listBlockersPage() {
        return { blockers: [], nextPage: null };
      },
      async addLabel(_repo: string, _ticket: number, label: string) {
        labels.push(label);
        effects.push("reserve");
      },
      async addAssignee(_repo: string, _ticket: number, account: string) {
        assignees.push(account);
      },
    },
    gitWorkspace: {
      ...deps.gitWorkspace,
      async createWorktree(input: { worktree: string; branch: string }) {
        worktree = input.worktree;
        branch = input.branch;
        await mkdir(worktree, { recursive: true });
        effects.push("worktree");
      },
      async inspect() {
        effects.push("verify");
        return {
          worktree,
          branch,
          base: "a".repeat(40),
          clean: true,
          changed: effects.includes("task"),
          commits: effects.includes("task") ? [commit] : [],
        };
      },
    },
    clock: {
      ...deps.clock,
      async sleep(ms: number) {
        effects.push(`sleep:${ms}`);
      },
    },
    terminalPlugin: {
      async createTab(options: {
        cwd: string;
        env: Readonly<Record<string, string>>;
      }) {
        assert.equal(options.cwd, worktree);
        assert.ok(path.isAbsolute(options.cwd));
        assert.ok(path.isAbsolute(options.env.GIT_CONFIG_GLOBAL!));
        assert.ok(await readFile(options.env.GIT_CONFIG_GLOBAL!, "utf8"));
        effects.push("open");
        return { privatePluginState: "NEVER_PERSIST_THIS" };
      },
      async submitText(_tab: object, text: string, chord?: string) {
        assert.ok(!text.includes("\r"));
        if (!effects.includes("start")) {
          effects.push("start");
          assert.equal(chord, "Enter");
          return;
        }
        assert.equal(chord, "Shift+Enter");
        const assignment = JSON.parse(
          text.slice(text.indexOf("\n") + 1, text.indexOf("\n\n")),
        ) as Record<string, unknown>;
        if (!effects.includes("probe")) {
          effects.push("probe");
          probe = assignment;
          assert.match(text, /Keep literal \$& and Unicode: \u4f60\u597d/);
          await writeFile(
            `${String(assignment.path)}.tmp`,
            JSON.stringify({
              ...assignment,
              sessionid: "native/$&/$`/$'/session",
              pr_title: "feat: [issue-50] implement the Issue",
              pr_body: "Implement the requested behavior.\n\nCloses #50",
            }),
          );
          await rename(
            `${String(assignment.path)}.tmp`,
            String(assignment.path),
          );
        } else {
          const saved = await snapshot();
          assert.equal(
            JSON.stringify(saved).includes("native/$&/$`/$'/session"),
            true,
          );
          handoff = String(assignment.path);
          assert.equal((saved.invocation as { path: string }).path, handoff);
          assert.match(text, /issue-runner-handoff/);
          assert.match(text, /Project implement instructions/);
          assert.equal(assignment.execution_id, probe.execution_id);
          effects.push("task");
          await writeFile(
            `${handoff}.tmp`,
            JSON.stringify({
              outcome: "committed",
              summary: "Implemented and verified.",
              commits: [commit],
              findings_file: null,
            }),
          );
          await rename(`${handoff}.tmp`, handoff);
        }
      },
      async closeTab() {
        const saved = await snapshot();
        assert.equal(saved.phase, "implementation_completed");
        assert.ok(JSON.stringify(saved).includes(commit.sha));
        assert.ok(!JSON.stringify(saved).includes("NEVER_PERSIST_THIS"));
        effects.push("close");
      },
    },
  };
  const result = await executeCli(command, dependencies);
  assert.equal(result.summary.outcome, "incomplete", JSON.stringify(result));
  assert.match(result.summary.reasons.join(" "), /CI-ready/u);
  assert.deepEqual(effects.slice(0, effects.indexOf("close") + 1), [
    "reserve",
    "worktree",
    "verify",
    "open",
    "start",
    "sleep:10000",
    "probe",
    "task",
    "verify",
    "close",
  ]);
  assert.ok(await readFile(handoff, "utf8"));
  assert.ok(
    deps.messages.some((message) => message.includes("sessionid=pending")),
  );
  assert.ok(
    deps.messages.some(
      (message) =>
        message.includes("native/$&/$`/$'/session") &&
        message.includes(handoff),
    ),
  );
});
