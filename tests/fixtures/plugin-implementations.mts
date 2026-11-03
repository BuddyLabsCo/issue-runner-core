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
        return tab;
      },
      async start(tab, command) {
        const input = options(tab);
        events.push(["start", tab, command]);
        return input.env.NATIVE_REF;
      },
      async resume(tab, command, sessionref) {
        options(tab);
        events.push(["resume", tab, command, sessionref]);
        return sessionref;
      },
      async submitText(tab, text, submitKey, expectedFile, recoveryText) {
        const input = options(tab);
        events.push([
          "submitText",
          tab,
          text,
          submitKey ?? input.submitKey,
          expectedFile,
          recoveryText,
        ]);
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
  async createEnhancement(host, context, config) {
    events.push(["enhancement factory", context, config]);
    let monitoring = false;
    let ref: string | undefined;
    return {
      async startMonitoring(sessionref) {
        ref = sessionref;
        monitoring = true;
        await host.sendKeys(["Right", "Enter"]);
        await host.submitText("readiness marker");
      },
      async waitUntilReady() {
        if (!monitoring) throw new Error("Monitoring is stopped");
        const observed = await host.read();
        if (!observed) {
          await host.requestRecovery();
          throw new Error("Not ready");
        }
        return ref ?? observed;
      },
      onAssignment(expectedFile) {
        events.push(["assignment", expectedFile]);
      },
      async stop() {
        monitoring = false;
      },
    };
  },
};
