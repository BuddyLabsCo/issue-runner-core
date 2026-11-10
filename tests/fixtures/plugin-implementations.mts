/* eslint-disable @typescript-eslint/require-await -- Representative external plugin implementations. */
import {
  terminalContractVersion,
  enhancementContractVersion,
  type CreateTabOptions,
  type EnhancementModule,
  type TerminalPluginModule,
} from "issue-runner-core/terminal";

export const events: unknown[][] = [];

export const terminalModule: TerminalPluginModule = {
  contractVersion: terminalContractVersion,
  async createTerminalPlugin(config = {}) {
    events.push(["terminal factory", config]);
    const tabs = new WeakMap<object, CreateTabOptions>();
    const options = (tab: object) => {
      const value = tabs.get(tab);
      if (!value) throw new Error("Unknown Runner Tab");
      return value;
    };
    return {
      async createTab(input) {
        const tab = {};
        tabs.set(tab, input);
        events.push(["createTab", tab, input]);
        return {
          handle: tab,
          io: {
            async read() {
              options(tab);
              return "visible plain text";
            },
            async submitText(text) {
              const input = options(tab);
              events.push(["submitText", tab, text, "Right", input.submitKey]);
            },
            async sendKeys(keys) {
              options(tab);
              events.push(["sendKeys", tab, keys]);
            },
          },
        };
      },
      async execute(tab, command) {
        options(tab);
        events.push(["execute", tab, command, "Right", "Enter"]);
      },
      async closeTab(tab) {
        options(tab);
        tabs.delete(tab);
        events.push(["closeTab", tab]);
      },
    };
  },
};

export const enhancementModule: EnhancementModule = {
  contractVersion: enhancementContractVersion,
  async createEnhancement(io, requestRecovery, context, config) {
    events.push(["enhancement factory", context, config]);
    let monitoring = false;
    let ref: string | undefined;
    let assignmentId = "";
    return {
      async startMonitoring(sessionref) {
        ref = sessionref;
        monitoring = true;
        await io.sendKeys(["Right", "Enter"]);
        await io.submitText("readiness marker");
      },
      async waitUntilReady() {
        if (!monitoring) throw new Error("Monitoring is stopped");
        const observed = await io.read();
        if (!observed) {
          await requestRecovery(assignmentId);
          throw new Error("Not ready");
        }
        return ref ?? observed;
      },
      onAssignment(assignment) {
        assignmentId = assignment.id;
        events.push(["assignment", assignment]);
        context.enhancementPause(assignment.id, "Human action needed");
      },
      async enhancementResume(id) {
        events.push(["resume", id]);
      },
      async stop() {
        monitoring = false;
      },
    };
  },
};
