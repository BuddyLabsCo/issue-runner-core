import assert from "node:assert/strict";
import {
  terminalInstallation,
  installEnhancement,
  genericEnhancement,
} from "../fixtures/enhancement-installation.mjs";
import path from "node:path";
import test from "node:test";
import {
  implementationRun,
  implementationCommand,
  committed,
  publish,
} from "../support/implementation-run.ts";
import { reviewRun, findings, passed } from "../support/review-run.ts";
import { ciRepairRun } from "../support/ci-repair-run.ts";
import { conflictRepairRun } from "../support/conflict-repair-run.ts";
import { documentationRun } from "../support/documentation-run.ts";
import { validConfig } from "../support/cli-project.ts";
import { executeCli, type CliDependencies } from "../../src/cli.ts";

await test("CLI discovers a same-prefix enhancement for the shared workflow", async (t) => {
  const fixture = await implementationRun(t);
  const installation = terminalInstallation(
    path.join(fixture.dependencies.launchDirectory, "global prefix"),
  );
  installEnhancement(installation.modules);
  const dependencies: CliDependencies = {
    ...fixture.dependencies,
    ...installation,
  };
  delete dependencies.enhancements;
  const result = await executeCli(implementationCommand, dependencies);
  assert.match(result.summary.tickets![0]!.detail, /CI-ready/);
  assert.equal(fixture.state.probeCount, 0);
  assert.equal(
    (await fixture.snapshot()).roles.implement?.sessionid,
    "discovered-native",
  );
});

for (const config of [
  undefined,
  {},
  { handoffRecoveryDelaySeconds: 120 },
  { arbitrary: [null, false, 42, "opaque"] },
  { "custom-agent": { retained: true } },
]) {
  await test(`discovered factory receives shared options unchanged: ${JSON.stringify(config)}`, async (t) => {
    const fixture = await implementationRun(t, {
      ...validConfig,
      terminalPlugins: config === undefined ? {} : { enhancements: config },
    });
    const installation = terminalInstallation(
      path.join(fixture.dependencies.launchDirectory, "global prefix"),
    );
    installEnhancement(
      installation.modules,
      genericEnhancement.replace(
        'events.push(["factory", config]);',
        'await io.sendKeys([JSON.stringify(config) ?? "undefined"]);',
      ),
    );
    const observed: (readonly string[])[] = [];
    const bind = fixture.dependencies.terminalPlugin.bindTab.bind(
      fixture.dependencies.terminalPlugin,
    );
    fixture.dependencies.terminalPlugin.bindTab = (handle, options) => {
      const tab = bind(handle, options);
      tab.io.sendKeys = (keys) => {
        observed.push(keys);
        return Promise.resolve();
      };
      return tab;
    };
    const dependencies: CliDependencies = {
      ...fixture.dependencies,
      ...installation,
    };
    delete dependencies.enhancements;
    assert.match(
      (await executeCli(implementationCommand, dependencies)).summary
        .tickets![0]!.detail,
      /CI-ready/,
    );
    assert.deepEqual(observed, [[JSON.stringify(config ?? {})]]);
  });
}

for (const [name, source, expected, tabs] of [
  [
    "version mismatch",
    'export const contractVersion = 99; export function createEnhancement() { throw new Error("must not call mismatched factory"); }',
    /CI-ready/,
    1,
  ],
  ["import failure", 'throw new Error("import failed");', /import failed/, 0],
  [
    "initialization failure",
    'export const contractVersion = 2; export function createEnhancement() { throw new Error("preflight failed"); }',
    /preflight failed/,
    1,
  ],
  [
    "invalid instance",
    "export const contractVersion = 2; export function createEnhancement() { return null; }",
    /expected an object/,
    1,
  ],
  ...["startMonitoring", "waitUntilReady", "onAssignment", "stop"].map(
    (method) =>
      [
        `missing ${method}`,
        genericEnhancement.replace(`${method}(`, `missing_${method}(`),
        /lifecycle methods/,
        1,
      ] as const,
  ),
] as const) {
  await test(`installed ${name} keeps discovery and lifecycle failure semantics`, async (t) => {
    const fixture = await implementationRun(t);
    const installation = terminalInstallation(
      path.join(fixture.dependencies.launchDirectory, "global prefix"),
    );
    installEnhancement(installation.modules, source);
    fixture.dependencies.operator.pause = () => Promise.resolve("s");
    const dependencies: CliDependencies = {
      ...fixture.dependencies,
      ...installation,
    };
    delete dependencies.enhancements;
    const result = await executeCli(implementationCommand, dependencies);
    assert.match(
      JSON.stringify(result) + fixture.dependencies.messages.join(" "),
      expected,
    );
    assert.equal(fixture.state.tabOptions.length, tabs);
    if (name === "version mismatch") {
      assert.equal(fixture.state.probeCount, 1);
      assert.match(
        fixture.dependencies.messages.join(" "),
        /Skipping.*contractVersion 99.*base startup/,
      );
    } else {
      assert.equal(result.exitCode, 1);
      assert.equal(fixture.state.taskCount, 0);
      assert.deepEqual(fixture.state.closedTabs, []);
    }
  });
}

for (const purpose of [
  "Review and fixes",
  "CI repair",
  "Conflict repair",
  "documentation",
]) {
  await test(`discovered modules receive default options for ${purpose} through the shared stage`, async (t) => {
    const fixture =
      purpose === "documentation"
        ? await documentationRun(t)
        : purpose === "CI repair"
          ? await ciRepairRun(t)
          : purpose === "Conflict repair"
            ? await conflictRepairRun(t)
            : await reviewRun(t);
    if ("reviewState" in fixture) {
      fixture.reviewState.onReview = (round) =>
        fixture.reviewState.reviews.length === 1
          ? findings(round)
          : publish(round.invocation!.path, passed());
    }
    const installation = terminalInstallation(
      path.join(fixture.dependencies.launchDirectory, "global prefix"),
    );
    for (const agent of ["custom-agent", "review-agent", "document-agent"])
      installEnhancement(
        installation.modules,
        'import assert from "node:assert/strict";\n' +
          genericEnhancement.replace(
            'events.push(["factory", config]);',
            "assert.deepEqual(config, {});",
          ),
        agent,
      );
    Object.assign(fixture.dependencies, installation);
    delete (fixture.dependencies as CliDependencies).enhancements;
    const result = await fixture.run();
    assert.ok(
      ["succeeded", "incomplete"].includes(result.summary.outcome),
      JSON.stringify(result),
    );
    assert.equal(fixture.state.probeCount, 0);
    const submissions = fixture.state.submissions
      .map((item) => item.text)
      .join("\n");
    assert.doesNotMatch(submissions, /Session Probe\n/);
    if (purpose === "Review and fixes") {
      assert.match(submissions, /Review assignment\n/);
      assert.match(submissions, /Fix assignment\n/);
    } else
      assert.match(
        submissions,
        new RegExp(
          `${purpose === "documentation" ? "Implementation" : purpose} assignment\n`,
        ),
      );
  });
}

await test("moving the terminal installation preserves enhanced recovery identity", async (t) => {
  const fixture = await implementationRun(t);
  const first = terminalInstallation(
    path.join(fixture.dependencies.launchDirectory, "first prefix"),
  );
  installEnhancement(first.modules);
  const dependencies: CliDependencies = { ...fixture.dependencies, ...first };
  delete dependencies.enhancements;
  fixture.state.onTask = () => {
    fixture.controller.abort();
    return Promise.resolve();
  };
  assert.equal(
    (await executeCli(implementationCommand, dependencies)).summary.outcome,
    "cancelled",
  );
  const saved = await fixture.snapshot();
  const second = terminalInstallation(
    path.join(fixture.dependencies.launchDirectory, "second prefix"),
  );
  installEnhancement(second.modules);
  fixture.state.evidence.commits = committed().commits;
  fixture.dependencies.terminalPlugin.execute = (_tab, command) => {
    assert.equal(command, 'any-cli --resume "discovered-native"');
    return Promise.resolve();
  };
  fixture.dependencies.terminalPlugin.onInput = (_tab, text) => {
    assert.equal(text, "continue");
    return publish(saved.invocation!.path, committed());
  };
  const result = await executeCli(implementationCommand, {
    ...dependencies,
    ...second,
    commandVersion: "9.0.0",
    signal: new AbortController().signal,
  });
  assert.match(result.summary.tickets![0]!.detail, /CI-ready/);
  const resumed = await fixture.snapshot();
  assert.equal(resumed.input_hash, saved.input_hash);
  assert.equal(resumed.execution_id, saved.execution_id);
  assert.equal(fixture.state.probeCount, 0);
});

for (const agent of ["constructor", "__proto__"]) {
  await test(`an absent enhancement for ${agent} takes the base path`, async (t) => {
    const fixture = await implementationRun(t, {
      ...validConfig,
      agents: {
        ...validConfig.agents,
        implement: { ...validConfig.agents.implement, agent },
      },
    });
    const installation = terminalInstallation(
      path.join(fixture.dependencies.launchDirectory, "global prefix"),
    );
    const dependencies: CliDependencies = {
      ...fixture.dependencies,
      ...installation,
    };
    delete dependencies.enhancements;
    const result = await executeCli(implementationCommand, dependencies);
    assert.match(result.summary.tickets![0]!.detail, /CI-ready/);
    assert.equal(fixture.state.probeCount, 1);
  });
}

await test("an installed enhancement named __proto__ receives the shared default options", async (t) => {
  const fixture = await implementationRun(t, {
    ...validConfig,
    agents: {
      ...validConfig.agents,
      implement: { ...validConfig.agents.implement, agent: "__proto__" },
    },
  });
  const installation = terminalInstallation(
    path.join(fixture.dependencies.launchDirectory, "global prefix"),
  );
  installEnhancement(
    installation.modules,
    'import assert from "node:assert/strict";\n' +
      genericEnhancement.replace(
        'events.push(["factory", config]);',
        "assert.deepEqual(config, {});",
      ),
    "__proto__",
  );
  const dependencies: CliDependencies = {
    ...fixture.dependencies,
    ...installation,
  };
  delete dependencies.enhancements;
  assert.match(
    (await executeCli(implementationCommand, dependencies)).summary.tickets![0]!
      .detail,
    /CI-ready/,
  );
  assert.equal(fixture.state.probeCount, 0);
});
