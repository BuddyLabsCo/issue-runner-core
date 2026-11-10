/* eslint-disable @typescript-eslint/require-await -- Controlled external boundaries. */
import type { TestContext } from "node:test";
import {
  enhancementContractVersion,
  type EnhancementContext,
} from "../../src/terminal.ts";
import { implementationRun } from "./implementation-run.ts";
import { validConfig } from "./cli-project.ts";

export async function enhancedImplementation(t: TestContext) {
  const fixture = await implementationRun(t, {
    ...validConfig,
    operationRetry: 0,
  });
  const control = {
    context: undefined as EnhancementContext | undefined,
    assignments: [] as { id: string; expectedFile: string }[],
    resumed: [] as string[],
    monitored: [] as (string | undefined)[],
    onAssignment: (id: string): void => {
      void id;
    },
    onResume: (id: string): Promise<void> => {
      void id;
      return Promise.resolve();
    },
  };
  fixture.dependencies.enhancements["custom-agent"] = {
    contractVersion: enhancementContractVersion,
    async createEnhancement(_io, _recover, context) {
      control.context = context;
      context.enhancementPause("not-assigned", "Ignore factory request");
      return {
        async startMonitoring(ref) {
          control.monitored.push(ref);
        },
        async waitUntilReady() {
          return "enhanced-native";
        },
        onAssignment(assignment) {
          control.assignments.push(assignment);
          control.onAssignment(assignment.id);
        },
        enhancementResume(id) {
          control.resumed.push(id);
          return control.onResume(id);
        },
        async stop() {
          return;
        },
      };
    },
  };
  return { ...fixture, control };
}
