/* eslint-disable @typescript-eslint/require-await -- Scripted external boundaries. */
import assert from "node:assert/strict";
import type { TestContext } from "node:test";
import type { CreateTabOptions } from "../../src/terminal.ts";
import type { CodeHost, GitWorkspace } from "../../src/run/contracts.ts";
import { implementationProgress, publish } from "./implementation-run.ts";
import { findings, fixCommit, passed } from "./review-run.ts";
import { child } from "./parent-run.ts";
import {
  batchDocumentationConfig,
  batchDocumentationRun,
} from "./batch-documentation-run.ts";

export async function fiveIssueRun(t: TestContext) {
  const children = [55, 53, 51, 54, 52].map((number) =>
    child(number, {
      labels: [
        "ready-for-agent",
        ...([51, 54].includes(number) ? ["Docs"] : []),
      ],
    }),
  );
  const fixture = await batchDocumentationRun(t, children, {
    ...batchDocumentationConfig,
    workflow: { review: true, docMaintainTriggerLabel: "Docs" },
  });
  const {
    tracker,
    terminalPlugin: terminal,
    codeHost,
    clock,
  } = fixture.dependencies;
  tracker.listChildrenPage = async (_repository, _parent, page) => ({
    children: structuredClone(children.slice((page - 1) * 3, page * 3)),
    nextPage: page === 1 ? 2 : null,
  });
  tracker.listBlockersPage = async (_repository, number, page) => ({
    blockers:
      number === 55
        ? structuredClone(
            children
              .filter((ticket) => ticket.number !== 55)
              .slice((page - 1) * 2, page * 2),
          )
        : [],
    nextPage: number === 55 && page === 1 ? 2 : null,
  });
  const tabs = new Map<object, CreateTabOptions>();
  const active = new Set<object>();
  const closed: string[] = [];
  const submissions: { tab: object; text: string; chord: string }[] = [];
  let maxActive = 0;
  const create = terminal.createTab.bind(terminal);
  terminal.createTab = async (options) => {
    assert.ok(
      [...active].every((tab) => tabs.get(tab)!.cwd !== options.cwd),
      "close each stage before opening its successor",
    );
    const tab = await create(options);
    tabs.set(tab, options);
    active.add(tab);
    maxActive = Math.max(maxActive, active.size);
    return tab;
  };
  const close = terminal.closeTab.bind(terminal);
  terminal.closeTab = async (tab) => {
    assert.ok(active.delete(tab), "close only an active owned Runner Tab");
    closed.push(tabs.get(tab)!.label);
    fixture.events.push(`tab:close:${tabs.get(tab)!.label}`);
    await close(tab);
  };
  const submit = terminal.submitText.bind(terminal);
  const fixed = new Set<string>();
  const git: GitWorkspace = fixture.dependencies.gitWorkspace;
  const inspect = git.inspect.bind(git);
  git.inspect = async (input) => {
    const evidence = await inspect(input);
    if (fixed.has(input.worktree)) evidence.commits.push(fixCommit);
    const baseIndex = evidence.commits.findIndex(
      (commit) => commit.sha === input.base,
    );
    if (input.base !== evidence.base && baseIndex >= 0) {
      evidence.commits = evidence.commits.slice(baseIndex + 1);
      evidence.base = input.base;
    }
    return evidence;
  };
  terminal.submitText = async (tab, text, chord = "Enter") => {
    assert.ok(active.has(tab), "submit only to an active owned Runner Tab");
    submissions.push({ tab, text, chord });
    const number = Number(/ticket-(\d+)$/u.exec(tabs.get(tab)!.cwd)![1]);
    if (
      text.startsWith("Session Probe\n") &&
      text.includes('"role":"review"')
    ) {
      const assignment = JSON.parse(text.split("\n")[1]!) as { path: string };
      await publish(assignment.path, {
        ...assignment,
        sessionid: `review-${number}`,
      });
    } else if (text.startsWith("Review assignment\n")) {
      const round = (
        await implementationProgress(fixture.directory, number)
      ).reviews!.at(-1)!;
      if (number === 51 && round.round === 1) await findings(round);
      else await publish(round.invocation!.path, passed());
    } else if (text.startsWith("Fix assignment\n")) {
      const round = (
        await implementationProgress(fixture.directory, number)
      ).reviews!.at(-1)!;
      fixed.add(tabs.get(tab)!.cwd);
      await publish(round.fix!.invocation!.path, {
        outcome: "committed",
        summary: "Resolved Review findings",
        commits: [fixCommit],
        findings_file: null,
      });
    } else await submit(tab, text);
  };
  // Bound missing scripted responses so regressions fail instead of polling forever.
  let polls = 0;
  const sleep = clock.sleep.bind(clock);
  clock.sleep = async (ms) => {
    if (ms === 250) assert.ok(++polls < 100, "missing scripted handoff");
    await sleep(ms);
  };
  const host: CodeHost = codeHost;
  const request = host.requestSquashMerge.bind(host);
  const integrations: number[] = [];
  host.requestSquashMerge = async (input) => {
    const pr = (await codeHost.listPullRequests()).find(
      (pr) => pr.number === input.pullRequest,
    )!;
    const number = Number(/ticket-(\d+)$/u.exec(pr.branch)![1]);
    integrations.push(number);
    fixture.events.push(`merge:${number}`);
    return request(input);
  };
  const get = codeHost.getPullRequest.bind(codeHost);
  codeHost.getPullRequest = async (repository, number) => {
    const pr = (await codeHost.listPullRequests()).find(
      (pr) => pr.number === number,
    )!;
    const ticket = Number(/ticket-(\d+)$/u.exec(pr.branch)![1]);
    return {
      ...(await get(repository, number)),
      createdAt: `2026-10-30T00:${String(ticket % 100).padStart(2, "0")}:00Z`,
    };
  };
  fixture.state.onDocument = (_file, commit) => commit();
  return {
    ...fixture,
    tabs,
    active,
    closed,
    submissions,
    integrations,
    get maxActive() {
      return maxActive;
    },
  };
}
