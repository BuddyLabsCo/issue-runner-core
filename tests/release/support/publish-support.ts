import {
  createReleaseFixture,
  type FixtureOptions,
  type ReleaseFixture,
} from "./release-fixture.ts";

export const releaseRepository = "BuddyLabsCo/issue-runner-core";

export const readyPackage = {
  manifest: {
    name: "issue-runner-core",
    repository: {
      type: "git",
      url: "git+https://github.com/BuddyLabsCo/issue-runner-core.git",
    },
    version: "0.1.0",
    description: "Ticket-driven delivery runner",
    license: "MIT",
    type: "module",
    exports: {
      "./cli": {
        types: "./dist/cli-entry.d.ts",
        default: "./dist/cli-entry.js",
      },
      "./terminal": {
        types: "./dist/terminal.d.ts",
        default: "./dist/terminal.js",
      },
    },
    files: [
      "dist",
      "prompts",
      "templates",
      "skills",
      "README.md",
      "CHANGELOG.md",
    ],
    engines: { node: ">=22.18.0" },
    scripts: { "release:accept": "node scripts/release-accept.mjs" },
  },
  files: {
    "dist/cli-entry.js": "export async function runCli() {}\n",
    "dist/cli-entry.d.ts": "export declare function runCli(): Promise<void>;\n",
    "dist/terminal.js":
      "export const terminalContractVersion = 2; export const enhancementContractVersion = 3;\n",
    "dist/terminal.d.ts": "export declare const terminalContractVersion = 2;\n",
    // The package check inspects supplied bytes; external services remain substitutes.
    "scripts/release-accept.mjs": [
      'import assert from "node:assert/strict";',
      'import { mkdtempSync, rmSync } from "node:fs";',
      'import { execFileSync } from "node:child_process";',
      'import { tmpdir } from "node:os";',
      'import { join } from "node:path";',
      'import { pathToFileURL } from "node:url";',
      'const directory = mkdtempSync(join(tmpdir(), "core-candidate-"));',
      "try {",
      '  execFileSync("tar", ["-xzf", process.env.RELEASE_TARBALL, "-C", directory]);',
      '  const before = process.listenerCount("SIGINT");',
      '  const cli = await import(pathToFileURL(join(directory, "package/dist/cli-entry.js")));',
      '  assert.equal(typeof cli.runCli, "function");',
      '  assert.equal(process.listenerCount("SIGINT"), before);',
      '  const terminal = await import(pathToFileURL(join(directory, "package/dist/terminal.js")));',
      "  assert.equal(terminal.terminalContractVersion, 2);",
      "  assert.equal(terminal.enhancementContractVersion, 3);",
      "} finally { rmSync(directory, { recursive: true, force: true }); }",
      "",
    ].join("\n"),
    "prompts/implement.md": "Implement the ticket.\n",
    "templates/config.yaml": "projects: []\n",
    "skills/issue-runner-handoff/SKILL.md": "# Handoff\n",
    "README.md": "# issue-runner-core\n",
    "CHANGELOG.md": "# Changelog\n",
  },
};

export const releaseBody =
  "## Proposed release 0.1.1\n\n### Changelog\n\n- fix: [issue-7] repair publication\n";

export function createPublishFixture(
  t: { after: (fn: () => void) => void },
  options: FixtureOptions = readyPackage,
): ReleaseFixture {
  return createReleaseFixture(t, options);
}

export function publishEnvironment(
  mergeSha: string,
  tarball: string,
  overrides: Record<string, string> = {},
): Record<string, string> {
  return {
    GITHUB_REPOSITORY: releaseRepository,
    PR_NUMBER: "18",
    PR_MERGED: "true",
    PR_HEAD_REF: "auto-release",
    PR_BASE_REF: "main",
    PR_HEAD_REPOSITORY: releaseRepository,
    MERGE_SHA: mergeSha,
    TARBALL: tarball,
    ACTIONS_ID_TOKEN_REQUEST_URL: "https://oidc.example.invalid/token",
    ACTIONS_ID_TOKEN_REQUEST_TOKEN: "test-oidc-request-token",
    ...overrides,
  };
}

// A merged release pull request for 0.1.1 and the tarball packed from the
// merged commit, exactly as the publication job provides them.
export function mergedRelease(fixture: ReleaseFixture): {
  merge: string;
  tarball: string;
} {
  fixture.propose("0.1.1");
  const merge = fixture.squashMerge();
  fixture.configureGitHub({
    pullRequest: {
      number: "18",
      title: "chore: propose release v0.1.1",
      body: releaseBody,
    },
  });
  return { merge, tarball: fixture.pack(fixture.artifacts) };
}
