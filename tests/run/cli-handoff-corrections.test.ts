import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";
import { validConfig } from "../support/cli-project.ts";
import { assertBusinessAssignment } from "../support/prompt-assignment.ts";
import {
  committed,
  implementationRun,
  publish,
} from "../support/implementation-run.ts";
import { publicationRun } from "../support/publication-run.ts";

for (const wrongHead of [false, true]) {
  await test(
    wrongHead
      ? "publication recovery rejects a recorded final SHA that is not Git HEAD"
      : "unordered implementation commits retain Git order and HEAD through publication recovery",
    async (t) => {
      const fixture = await publicationRun(t);
      const commits = [
        ...committed().commits,
        { sha: "c".repeat(40), message: "Agent-reported second commit" },
        { sha: "d".repeat(40), message: "Agent-reported HEAD" },
      ];
      fixture.state.onTask = async (file) => {
        fixture.state.evidence.commits = commits.map(({ sha }) => ({
          sha,
          message: "Git subject",
        }));
        await publish(file, {
          ...committed(),
          commits: [...commits].reverse(),
        });
      };
      fixture.state.onCorrection = () => {
        fixture.controller.abort();
        return Promise.resolve();
      };
      const push = fixture.dependencies.gitWorkspace.push.bind(
        fixture.dependencies.gitWorkspace,
      );
      fixture.dependencies.gitWorkspace.push = () => {
        fixture.controller.abort();
        return Promise.resolve();
      };
      assert.equal((await fixture.run()).summary.outcome, "cancelled");
      const saved = await fixture.snapshot();
      assert.deepEqual(saved.result?.commits, commits);
      assert.deepEqual(saved.publication?.commits, commits);
      assert.equal(saved.publication?.headSha, commits[2]!.sha);

      // Equal membership, different order for commits other than HEAD.
      const [first, second, head] = fixture.state.evidence.commits;
      fixture.state.evidence.commits = [second!, first!, head!];
      if (wrongHead) {
        saved.result.commits.reverse();
        saved.publication.commits.reverse();
        saved.publication.headSha = commits[0]!.sha;
        await publish(
          path.join(
            fixture.directory,
            "recovery",
            `${saved.input_hash}-50.json`,
          ),
          saved,
        );
      }
      fixture.dependencies.signal = new AbortController().signal;
      fixture.dependencies.gitWorkspace.push = push;
      const recovered = await fixture.run();
      if (wrongHead) {
        assert.match(recovered.summary.tickets![0]!.detail, /HEAD mismatch/u);
        assert.equal(fixture.publicationState.pushes, 0);
        assert.equal(fixture.publicationState.creations, 0);
        return;
      }
      assert.match(recovered.summary.tickets![0]!.detail, /CI-ready/u);
      const after = await fixture.snapshot();
      assert.deepEqual(after.result?.commits, commits);
      assert.deepEqual(after.publication?.commits, commits);
      assert.equal(
        fixture.publicationState.branches.get(saved.branch),
        commits[2]!.sha,
      );
      assert.equal(fixture.state.taskCount, 1);
      assert.equal(fixture.dependencies.pauses.length, 0);
    },
  );
}

await test("execution findings receive a specific correction in the original conversation", async (t) => {
  const fixture = await implementationRun(t);
  fixture.state.onTask = async (file) => {
    fixture.state.evidence.commits = committed().commits;
    await publish(file, { ...committed(), findings_file: file });
  };
  fixture.state.onCorrection = async (file) => {
    const correction = fixture.state.submissions.at(-1)!;
    assert.match(correction.text, /Execution findings_file must be null/);
    assert.equal(correction.tab, fixture.state.submissions[2]!.tab);
    assert.equal(correction.chord, "Shift+Enter");
    assertBusinessAssignment(correction, file);
    assert.ok(correction.text.includes(JSON.stringify(file)));
    assert.equal((await fixture.snapshot()).phase, "implementing");
    assert.equal(fixture.state.closedTabs.length, 0);
    await publish(file, committed());
  };
  const result = await fixture.run();
  assert.equal(result.summary.outcome, "incomplete", JSON.stringify(result));
  assert.equal((await fixture.snapshot()).phase, "implementation_completed");
  assert.deepEqual(
    fixture.state.sleeps.filter((ms) => ms !== 30_000 && ms !== 10_000),
    [],
  );
});

await test("each invalid publication receives immediate feedback at a fresh path without exhaustion", async (t) => {
  const legacy = { agentRetry: 0, agentRetryDelay: [300, 300] };
  const fixture = await implementationRun(t, { ...validConfig, ...legacy });
  const paths: string[] = [];
  const invocations: string[] = [];
  fixture.state.onTask = async (file) => {
    paths.push(file);
    invocations.push((await fixture.snapshot()).invocation!.invocation_id);
    fixture.state.evidence.commits = committed().commits;
    await publish(file, {});
  };
  fixture.state.onCorrection = async (file) => {
    const saved = await fixture.snapshot();
    assert.deepEqual(saved.superseded, paths);
    assert.equal(saved.phase, "implementing");
    const correction = fixture.state.submissions.at(-1)!;
    assert.equal(correction.tab, fixture.state.submissions[0]!.tab);
    assert.equal(correction.chord, "Shift+Enter");
    assertBusinessAssignment(correction, file);
    assert.equal(fixture.state.closedTabs.length, 0);
    paths.push(file);
    invocations.push(saved.invocation!.invocation_id);
    assert.ok(paths.length <= 6);
    await publish(paths[0]!, committed());
    await publish(file, paths.length < 6 ? {} : committed());
  };
  fixture.state.onSleep = (ms) => {
    assert.ok(ms === 10_000 || ms === 30_000, `unexpected wait: ${ms}`);
    return Promise.resolve();
  };
  const result = await fixture.run();
  assert.equal(result.summary.outcome, "incomplete", JSON.stringify(result));
  const saved = await fixture.snapshot();
  assert.equal(saved.phase, "implementation_completed");
  assert.equal(paths.length, 6);
  assert.equal(new Set(paths).size, 6);
  assert.equal(new Set(invocations).size, 6);
  assert.equal(fixture.state.submissions.length, 8);
  assert.equal(fixture.state.taskCount, 1);
  assert.equal(fixture.state.closedTabs.length, 1);
});

for (const [mismatch, reason] of [
  ["branch", /Delivery branch mismatch/u],
  ["base", /Base SHA mismatch/u],
  ["worktree", /Worktree path mismatch/u],
  ["clean", /Worktree must be clean/u],
  ["commits", /Claimed commits do not match actual Git commits/u],
  ["changed", /no actual changes/u],
] as const) {
  await test(`false Git ${mismatch} claims receive actionable corrections before acceptance`, async (t) => {
    const fixture = await implementationRun(t);
    const evidence = fixture.state.evidence;
    fixture.state.onTask = async (file) => {
      evidence.commits = structuredClone(committed().commits);
      const correct = structuredClone(evidence);
      if (mismatch === "clean" || mismatch === "changed")
        evidence[mismatch] = false;
      else if (mismatch === "commits")
        evidence.commits[0]!.sha = "f".repeat(40);
      else evidence[mismatch] = "wrong";
      fixture.state.onCorrection = async (correctedPath) => {
        assert.match(fixture.state.submissions.at(-1)!.text, reason);
        assert.equal((await fixture.snapshot()).phase, "implementing");
        assert.equal(fixture.state.closedTabs.length, 0);
        Object.assign(evidence, correct);
        await publish(correctedPath, committed());
      };
      await publish(file, committed());
    };
    const result = await fixture.run();
    assert.equal(result.summary.outcome, "incomplete", JSON.stringify(result));
    assert.equal((await fixture.snapshot()).phase, "implementation_completed");
  });
}

for (const invalid of ["missing", "extra", "duplicate"] as const) {
  await test(`${invalid} claimed commits are rejected before acceptance`, async (t) => {
    const fixture = await implementationRun(t);
    const commits = [
      ...committed().commits,
      { sha: "c".repeat(40), message: "Second commit" },
    ];
    fixture.state.onTask = async (file) => {
      fixture.state.evidence.commits = commits;
      const claims =
        invalid === "missing"
          ? [commits[0]!]
          : invalid === "extra"
            ? [...commits, { sha: "d".repeat(40), message: "Extra commit" }]
            : [commits[0]!, commits[0]!];
      await publish(file, { ...committed(), commits: claims });
    };
    fixture.state.onCorrection = async (file) => {
      assert.match(
        fixture.state.submissions.at(-1)!.text,
        invalid === "duplicate"
          ? /Duplicate claimed commits/u
          : /Claimed commits do not match actual Git commits/u,
      );
      await publish(file, { ...committed(), commits });
    };
    assert.equal((await fixture.run()).summary.outcome, "incomplete");
    const saved = await fixture.snapshot();
    assert.equal(saved.superseded.length, 1);
    assert.deepEqual(saved.result?.commits, commits);
  });
}
