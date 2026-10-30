import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";
import type { CreateTabOptions } from "../../src/terminal.ts";
import { validConfig } from "../support/cli-project.ts";
import {
  deferred,
  implementationProgress as progress,
  publish,
} from "../support/implementation-run.ts";
import { child, parentRun } from "../support/parent-run.ts";
import { passed } from "../support/review-run.ts";

for (const selector of ["parent", "issue"] as const) {
  await test(`${selector} keeps concurrent Reviews isolated when the second Issue completes first`, async (t) => {
    const fixture = await parentRun(t, [child(51), child(52), child(53)], {
      ...validConfig,
      issueList: selector === "issue" ? [51, 52, 53] : [],
      maxBatchSize: 2,
      workflow: { review: true },
    });
    const arrived = new Map(
      [51, 52].map((number) => [number, deferred<void>()]),
    );
    const gates = new Map([51, 52].map((number) => [number, deferred<void>()]));
    const secondClosed = deferred<void>();
    const tabs = new Map<
      object,
      { number: number; review: boolean; options: CreateTabOptions }
    >();
    const closed: string[] = [];
    const createTab = fixture.dependencies.terminalPlugin.createTab.bind(
      fixture.dependencies.terminalPlugin,
    );
    const submit = fixture.dependencies.terminalPlugin.submitText.bind(
      fixture.dependencies.terminalPlugin,
    );
    fixture.dependencies.terminalPlugin.createTab = async (options) => {
      const number = Number(/ticket-(\d+)$/u.exec(options.cwd)![1]);
      const review = options.label === `Issue #${number} review`;
      if (review) assert.ok(closed.includes(`${number}:implement`));
      const tab = await createTab(options);
      tabs.set(tab, { number, review, options });
      return tab;
    };
    fixture.dependencies.terminalPlugin.submitText = async (tab, text) => {
      const { number, review } = tabs.get(tab)!;
      if (review && text.startsWith("Session Probe\n")) {
        const assignment = JSON.parse(text.split("\n")[1]!) as {
          ticket: number;
          role: string;
          path: string;
        };
        assert.equal(assignment.ticket, number);
        assert.equal(assignment.role, "review");
        await publish(assignment.path, {
          ...assignment,
          sessionid: `review-${number}`,
        });
      } else if (review && text.startsWith("Review assignment\n")) {
        const saved = await progress(fixture.directory, number);
        const round = saved.reviews![0]!;
        assert.ok(text.includes(saved.worktree));
        assert.ok(text.includes(saved.branch));
        assert.ok(text.includes(round.findings));
        assert.match(
          path.basename(round.invocation!.path),
          new RegExp(`^${number}-review-`, "u"),
        );
        arrived.get(number)!.resolve();
        await gates.get(number)!.promise;
        await publish(round.invocation!.path, passed());
      } else await submit(tab, text);
    };
    fixture.dependencies.terminalPlugin.closeTab = async (tab) => {
      const { number, review } = tabs.get(tab)!;
      assert.equal(
        (await progress(fixture.directory, number)).phase,
        review ? "review_completed" : "implementation_completed",
      );
      closed.push(`${number}:${review ? "review" : "implement"}`);
      if (number === 52 && review) secondClosed.resolve();
    };
    const running = fixture.run([
      `--${selector}`,
      ...(selector === "parent" ? ["48"] : []),
    ]);
    const deadline = setTimeout(
      () => arrived.get(52)!.reject(new Error("Reviews did not overlap")),
      5000,
    );
    try {
      await Promise.all([...arrived.values()].map(({ promise }) => promise));
      clearTimeout(deadline);
      const reviews = [...tabs.values()].filter((tab) => tab.review);
      assert.equal(reviews.length, 2);
      assert.equal(
        new Set(reviews.map(({ options }) => options.env.GIT_CONFIG_GLOBAL))
          .size,
        2,
      );
      const before = await Promise.all(
        [51, 52].map((number) => progress(fixture.directory, number)),
      );
      for (const item of before) {
        assert.equal(item.phase, "reviewing");
        assert.equal(item.roles.implement!.sessionid, `native-${item.ticket}`);
        assert.equal(item.roles.review!.sessionid, `review-${item.ticket}`);
        assert.match(item.pr_body!, new RegExp(`Closes #${item.ticket}$`, "u"));
      }
      gates.get(52)!.resolve();
      await secondClosed.promise;
      assert.equal((await progress(fixture.directory, 51)).phase, "reviewing");
      assert.equal(closed.includes("51:review"), false);
      gates.get(51)!.resolve();
      const result = await running;
      assert.equal(
        result.summary.outcome,
        "incomplete",
        JSON.stringify(result),
      );
      assert.deepEqual(
        closed.filter((item) => item.endsWith(":review")),
        ["52:review", "51:review"],
      );
      for (const number of [51, 52])
        assert.equal(
          (await progress(fixture.directory, number)).phase,
          "publication_eligible",
        );
      assert.deepEqual([...fixture.dispatched].sort(), [51, 52]);
      assert.equal(
        fixture.writes.some((item) => item.endsWith(":53")),
        false,
      );
    } finally {
      clearTimeout(deadline);
      for (const gate of gates.values()) gate.resolve();
      await running;
    }
  });
}
