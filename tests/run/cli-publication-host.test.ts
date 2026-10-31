import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { GitHubCodeHost } from "../../src/adapters/github-code-host.ts";
import { executeCli } from "../../src/cli.ts";
import { implementationCommand } from "../support/implementation-run.ts";
import { publicationRun } from "../support/publication-run.ts";

await test("publication uses paginated same-repository PR evidence, non-draft creation and exact multiline metadata through the GitHub adapter", async (t) => {
  const fixture = await publicationRun(t);
  const commands: string[][] = [];
  let created = false;
  let bodyFile = "";
  const adapter = new GitHubCodeHost("host-secret", async (args, options) => {
    commands.push(args);
    assert.equal(options.token, "host-secret");
    if (args[0] === "api" && args[1] === "--method")
      return JSON.stringify({ default_branch: "default-branch" });
    const saved = await fixture.snapshot();
    if (args[1]?.includes("/git/ref/heads/")) {
      assert.equal(
        args[1],
        `repos/owner/repo/git/ref/heads/${encodeURIComponent(saved.branch)}`,
      );
      const sha = fixture.publicationState.branches.get(saved.branch);
      if (!sha) throw new Error("gh command failed: HTTP 404: Not Found");
      return JSON.stringify({ object: { sha } });
    }
    if (args.includes("--paginate")) {
      assert.ok(args.includes("--slurp"));
      const record = {
        number: 81,
        html_url: "https://github.com/owner/repo/pull/81",
        state: "open",
        merged_at: null,
        draft: false,
        head: {
          ref: saved.branch,
          sha: saved.publication?.headSha,
          repo: { full_name: "owner/repo" },
        },
        base: { ref: "default-branch" },
      };
      return JSON.stringify([
        [
          {
            ...record,
            number: 99,
            head: { ...record.head, repo: { full_name: "fork/repo" } },
          },
        ],
        created ? [record] : [],
      ]);
    }
    if (args[1] === "create") {
      assert.equal(args.includes("--draft"), false);
      assert.equal(args[args.indexOf("--title") + 1], saved.pr_title);
      bodyFile = args[args.indexOf("--body-file") + 1]!;
      assert.equal(
        await readFile(bodyFile, "utf8"),
        "Implement the Issue.\n\nCloses #50",
      );
      created = true;
      return "https://github.com/owner/repo/pull/81\n";
    }
    if (args[1] === "checks") {
      assert.ok(args.includes("--required"));
      assert.deepEqual(options.allowedExitCodes, [1, 8]);
      return "[]";
    }
    assert.fail(`unexpected command: ${args.join(" ")}`);
  });
  const result = await executeCli(
    [...implementationCommand, "--no-auto-merge"],
    {
      ...fixture.dependencies,
      codeHost: adapter,
    },
  );
  assert.match(
    result.summary.reasons.join(" "),
    /CI-ready/u,
    JSON.stringify(result),
  );
  assert.equal(commands.filter((args) => args[1] === "create").length, 1);
  await assert.rejects(readFile(bodyFile), { code: "ENOENT" });
});
