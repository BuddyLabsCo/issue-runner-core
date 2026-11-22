/* eslint-disable @typescript-eslint/require-await -- Scripted external boundaries. */
import assert from "node:assert/strict";
import test from "node:test";
import {
  ActionsRerunRejected,
  type ActionsRunObservation,
  type RequiredCheck,
} from "../../src/run/contracts.ts";
import { ciRepairRun, failedCheck } from "../support/ci-repair-run.ts";
import { validConfig } from "../support/cli-project.ts";
import { publish } from "../support/implementation-run.ts";

interface RerunScenario {
  checks: RequiredCheck[];
  run: ActionsRunObservation;
  post?: (requests: number) => void;
  resume?: () => void;
  poll?: () => void;
}

const actionsCheck = { ...failedCheck, actionsRunId: "45019148280" };
const passingCheck = {
  ...actionsCheck,
  state: "SUCCESS",
  bucket: "pass" as const,
};
const successfulAttempt = {
  attempt: 2,
  status: "completed",
  conclusion: "success",
};

const rerunScenarios: {
  name: string;
  reason: RegExp;
  requests: number;
  ready: boolean;
  script?: (scenario: RerunScenario) => (() => void) | void;
}[] = [
  {
    name: "cannot locate an Actions run",
    reason: /no GitHub Actions run was identified/u,
    requests: 0,
    ready: false,
    script(scenario) {
      scenario.checks = [failedCheck];
    },
  },
  {
    name: "retries after a forbidden POST",
    reason: /Cannot rerun failed jobs.*HTTP 403/u,
    requests: 2,
    ready: true,
    script(scenario) {
      scenario.post = (requests) => {
        if (requests === 1) throw new ActionsRerunRejected("HTTP 403");
        scenario.run = successfulAttempt;
        scenario.checks = [passingCheck];
      };
    },
  },
  {
    name: "waits for the new attempt after a lost POST response",
    reason: /Cannot rerun failed jobs.*response lost/u,
    requests: 1,
    ready: true,
    script(scenario) {
      scenario.post = () => {
        throw new Error("response lost");
      };
      scenario.resume = () => {
        scenario.poll = () => {
          scenario.run = successfulAttempt;
          scenario.checks = [passingCheck];
        };
      };
    },
  },
  {
    name: "waits for active CI after acknowledging a failed rerun",
    reason: /GitHub Actions rerun.*attempt 2 failed \(failure\)/u,
    requests: 1,
    ready: true,
    script(scenario) {
      const pending = {
        ...failedCheck,
        name: "other required check",
        state: "IN_PROGRESS",
        bucket: "pending" as const,
      };
      let mixedPolls = 0;
      scenario.post = () => {
        scenario.run.attempt = 2;
      };
      scenario.resume = () => {
        scenario.checks = [actionsCheck, pending];
        scenario.poll = () => {
          assert.deepEqual(scenario.checks, [actionsCheck, pending]);
          mixedPolls++;
          scenario.checks = [
            passingCheck,
            { ...pending, state: "SUCCESS", bucket: "pass" },
          ];
        };
      };
      return () => assert.equal(mixedPolls, 1);
    },
  },
  {
    name: "pauses when a new attempt never appears",
    reason: /GitHub Actions rerun.*timed out waiting for required checks/u,
    requests: 1,
    ready: false,
  },
];

for (const { name, reason, requests, ready, script } of rerunScenarios) {
  await test(`a no-change CI repair ${name}`, async (t) => {
    const fixture = await ciRepairRun(t, {
      ...validConfig,
      timeouts: { ...validConfig.timeouts, requiredChecksMinutes: 1 },
    });
    const scenario: RerunScenario = {
      checks: [actionsCheck],
      run: { attempt: 1, status: "completed", conclusion: "failure" },
    };
    const verify = script?.(scenario);
    fixture.repairs.onTask = (file) =>
      publish(file, {
        outcome: "no_change",
        summary: "No local repair needed",
        commits: [],
        findings_file: null,
      });
    fixture.publicationState.onChecks = async () => scenario.checks;
    fixture.dependencies.codeHost.observeActionsRun = async () => scenario.run;
    let reruns = 0;
    fixture.dependencies.codeHost.rerunFailedJobs = async () => {
      reruns++;
      scenario.post?.(reruns);
    };
    let pauses = 0;
    fixture.dependencies.operator.pause = async (message) => {
      assert.match(message, reason);
      pauses++;
      assert.equal(pauses, 1);
      scenario.resume?.();
      return ready ? "" : "q";
    };
    fixture.state.onSleep = async () => {
      scenario.poll?.();
    };
    const result = await fixture.run();
    if (ready) assert.match(result.summary.tickets![0]!.detail, /CI-ready/u);
    else assert.equal(result.summary.outcome, "cancelled");
    assert.equal(pauses, 1);
    assert.equal(reruns, requests);
    assert.equal(fixture.repairs.tasks.length, 1);
    verify?.();
  });
}
