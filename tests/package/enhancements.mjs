import assert from "node:assert/strict";
import {
  cpSync,
  mkdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, relative } from "node:path";
import { pathToFileURL } from "node:url";
import {
  genericEnhancement,
  installEnhancement,
  terminalInstallation,
  writeJson,
} from "../fixtures/enhancement-installation.mjs";

/**
 * @param {import("node:test").TestContext} t
 * @param {{ core: string, plugin: string, prefix: string, launch: string,
 *   runNode: (args: string[], cwd: string, env?: NodeJS.ProcessEnv) => string }} options
 */
export async function testEnhancements(
  t,
  { core, plugin, prefix, launch, runNode },
) {
  const discovery = pathToFileURL(
    join(core, "dist/adapters/enhancement-discovery.js"),
  ).href;
  const conversation = pathToFileURL(
    join(core, "dist/agent/conversation.js"),
  ).href;
  /** @param {ReturnType<typeof terminalInstallation>} installation @param {string} assertions @param {string[]} [agents] */
  const check = (installation, assertions, agents = ["custom-agent"]) =>
    runNode(
      [
        "--input-type=module",
        "--eval",
        `
    import assert from "node:assert/strict";
    import { discoverEnhancements } from ${JSON.stringify(discovery)};
    const messages = [];
    const discover = () => discoverEnhancements(${JSON.stringify(installation)}, ${JSON.stringify(agents)}, message => messages.push(message));
    ${assertions}
  `,
      ],
      launch,
      {
        ...process.env,
        npm_config_prefix: join(launch, "other prefix"),
        NODE_PATH: join(launch, "other prefix/node_modules"),
      },
    );
  let sequence = 0;
  const fresh = (layout = "windows", name = "generic-terminal") =>
    terminalInstallation(
      join(launch, `fixture-${++sequence}`),
      /** @type {"unix" | "windows" | "project" | "project-lib"} */ (layout),
      name,
    );
  const decoy = "throw new Error('decoy imported');";
  installEnhancement(join(launch, "node_modules"), decoy);
  installEnhancement(join(launch, "other prefix/node_modules"), decoy);

  for (const layout of process.platform === "win32"
    ? ["windows"]
    : ["unix", "windows"]) {
    await t.test(
      `${layout} same-prefix discovery ignores local, nested, and other-prefix decoys`,
      () => {
        const installation = fresh(layout);
        installEnhancement(installation.modules);
        installEnhancement(
          join(installation.terminalPackageRoot, "node_modules"),
          decoy,
        );
        check(
          installation,
          `const modules = await discover(); assert.deepEqual(Object.keys(modules), ["custom-agent"]); assert.deepEqual(modules["custom-agent"].events, []); assert.deepEqual(messages, []);`,
        );
      },
    );
    await t.test(`${layout} rejects a launcher targeting another entry`, () => {
      const installation = fresh(layout);
      installEnhancement(installation.modules, decoy);
      const other = join(installation.terminalPackageRoot, "other.mjs");
      writeFileSync(other, "export {};");
      rmSync(installation.launcher);
      if (layout === "unix") symlinkSync(other, installation.launcher);
      else
        writeFileSync(
          installation.launcher,
          '@echo off\r\nnode "%~dp0\\node_modules\\generic-terminal\\other.mjs" %*\r\n',
        );
      check(
        installation,
        `await assert.rejects(discover(), /matching same-prefix global launcher/);`,
      );
    });
  }
  for (const layout of ["project", "project-lib"]) {
    await t.test(
      `${layout} cannot authorize a sibling enhancement without a global launcher`,
      () => {
        const installation = fresh(layout);
        installEnhancement(installation.modules, decoy);
        check(
          installation,
          `await assert.rejects(discover(), /matching same-prefix global launcher/);`,
        );
      },
    );
  }
  await t.test(
    "nested installed Core uses the terminal prefix and creates independent enhancements per tab",
    () => {
      assert.ok(
        relative(plugin, core).startsWith("node_modules"),
        "fixture must actually nest Core",
      );
      const installation = {
        commandName: "generic-terminal",
        terminalPackageRoot: plugin,
        terminalCliEntry: join(plugin, "command.js"),
        modules: dirname(plugin),
        prefix,
        launcher: "unused",
      };
      installEnhancement(installation.modules);
      installEnhancement(join(plugin, "node_modules"), decoy);
      check(
        installation,
        `
      const { NativeConversations } = await import(${JSON.stringify(conversation)});
      const modules = await discover();
      const module = modules["custom-agent"];
      assert.deepEqual(module.events, [], "discovery must not initialize instances");
      const commands = [];
      const plugin = {
        async createTab() { return { handle: {}, io: { async read() { return ""; }, async submitText() {}, async sendKeys() {} } }; },
        async execute(handle, text) { commands.push(text); }, async closeTab() {},
      };
      const conversations = new NativeConversations(plugin);
      const options = { cwd: process.cwd(), env: {}, label: "installed", submitKey: "Enter" };
      const one = await conversations.create(options, module, ["unknown", 17]);
      const two = await conversations.create(options, module, false);
      for (const tab of [one, two]) {
        assert.equal(await conversations.ready(tab, { start: "agent start" }, undefined, () => assert.fail("enhanced startup must not wait the base delay")), "discovered-native");
        await conversations.close(tab);
      }
      assert.deepEqual(commands, ["agent start", "agent start"]);
      assert.deepEqual(module.events, [["factory", ["unknown", 17]], ["factory", false], ["monitor", undefined], ["stop"], ["monitor", undefined], ["stop"]]);
    `,
      );
      rmSync(join(installation.modules, "issue-runner-agent-custom-agent"), {
        recursive: true,
      });
    },
  );
  await t.test(
    "Core installed beside the terminal selects the same enhancement",
    () => {
      const installation = fresh();
      const siblingCore = join(installation.modules, "issue-runner-core");
      cpSync(core, siblingCore, { recursive: true });
      installEnhancement(installation.modules);
      check(
        installation,
        `
      const sibling = await import(${JSON.stringify(pathToFileURL(join(siblingCore, "dist/adapters/enhancement-discovery.js")).href)});
      const fromNested = await discover();
      const fromSibling = await sibling.discoverEnhancements(${JSON.stringify(installation)}, ["custom-agent"], () => assert.fail("unexpected diagnostic"));
      assert.equal(fromNested["custom-agent"], fromSibling["custom-agent"]);
      assert.deepEqual(fromSibling["custom-agent"].events, []);
    `,
      );
    },
  );
  await t.test(
    "scoped terminal identity and percent-tilde-dp0 shim are accepted",
    () => {
      const installation = fresh("windows", "@example/terminal-package");
      writeFileSync(
        installation.launcher,
        readFileSync(installation.launcher, "utf8").replace("%dp0%", "%~dp0"),
      );
      installEnhancement(installation.modules);
      check(
        installation,
        `assert.deepEqual(Object.keys(await discover()), ["custom-agent"]);`,
      );
    },
  );
  await t.test("npm string bin declaration is accepted", () => {
    const installation = fresh();
    writeJson(join(installation.terminalPackageRoot, "package.json"), {
      name: "generic-terminal",
      bin: "command.mjs",
    });
    check(installation, `assert.deepEqual(Object.keys(await discover()), []);`);
  });
  for (const invalid of [
    "name",
    "bin",
    "entry",
    "executable escape",
    "executable traversal",
    "entry symlink",
    "package symlink",
    "dangling package",
    "entry traversal",
    "missing entry",
    "directory entry",
  ]) {
    await t.test(`installed discovery rejects ${invalid}`, () => {
      const installation = fresh();
      const enhancement = installEnhancement(installation.modules, decoy);
      const outside = join(installation.prefix, "outside");
      mkdirSync(outside);
      writeFileSync(join(outside, "index.mjs"), decoy);
      const manifest = join(installation.terminalPackageRoot, "package.json");
      if (invalid === "name")
        writeJson(manifest, {
          name: "wrong-terminal",
          bin: { "generic-terminal": "command.mjs" },
        });
      if (invalid === "bin") writeJson(manifest, { name: "generic-terminal" });
      if (invalid === "entry")
        installation.terminalCliEntry = join(outside, "index.mjs");
      if (invalid === "executable traversal")
        writeJson(manifest, {
          name: "generic-terminal",
          bin: { "generic-terminal": "../../outside/index.mjs" },
        });
      if (invalid === "executable escape") {
        symlinkSync(
          outside,
          join(installation.terminalPackageRoot, "linked"),
          process.platform === "win32" ? "junction" : "dir",
        );
        writeJson(manifest, {
          name: "generic-terminal",
          bin: { "generic-terminal": "linked/index.mjs" },
        });
      }
      if (invalid === "package symlink" || invalid === "dangling package") {
        rmSync(enhancement, { recursive: true });
        symlinkSync(
          outside,
          enhancement,
          process.platform === "win32" ? "junction" : "dir",
        );
        if (invalid === "dangling package")
          rmSync(outside, { recursive: true });
      }
      if (invalid === "entry symlink") {
        symlinkSync(
          outside,
          join(enhancement, "linked"),
          process.platform === "win32" ? "junction" : "dir",
        );
        writeJson(join(enhancement, "package.json"), {
          exports: "./linked/index.mjs",
        });
      }
      if (invalid === "entry traversal")
        writeJson(join(enhancement, "package.json"), {
          main: "../../outside/index.mjs",
        });
      if (invalid === "missing entry") rmSync(join(enhancement, "index.mjs"));
      if (invalid === "directory entry")
        writeJson(join(enhancement, "package.json"), { exports: "./" });
      check(
        installation,
        `await assert.rejects(discover(), /identity|executable|CLI entry|same npm prefix|escapes its installed package|ENOENT|entry must be a file/);`,
      );
    });
  }
  for (const agent of [
    "custom-agent",
    "Opaque / name",
    "../generic",
    "generic/../../elsewhere",
    "GENERIC",
    "a".repeat(215),
  ]) {
    await t.test(
      `absence or non-package Agent identifier uses the base path: ${agent.slice(0, 30)}`,
      () => {
        check(
          fresh(),
          `assert.deepEqual(Object.keys(await discover()), []); assert.deepEqual(messages, []);`,
          [agent],
        );
      },
    );
  }
  for (const [name, source, expected] of [
    [
      "default-only exports",
      "export default { contractVersion: 2, createEnhancement() {} };",
      "contractVersion",
    ],
    [
      "missing version",
      "export function createEnhancement() {}",
      "contractVersion",
    ],
    ...[
      "0",
      "-1",
      "1.5",
      "NaN",
      "Infinity",
      '"2"',
      "null",
      "9007199254740992",
    ].map((value) => [
      `invalid version ${value}`,
      `export const contractVersion = ${value}; export function createEnhancement() {}`,
      "contractVersion",
    ]),
    [
      "missing factory",
      "export const contractVersion = 2;",
      "createEnhancement",
    ],
    [
      "mismatch with missing factory",
      "export const contractVersion = 99;",
      "createEnhancement",
    ],
    [
      "non-callable factory",
      "export const contractVersion = 2; export const createEnhancement = 1;",
      "createEnhancement",
    ],
    [
      "missing transitive dependency",
      "import 'missing-transitive-enhancement-dependency';",
      "missing-transitive-enhancement-dependency",
    ],
    [
      "top-level failure",
      "throw new Error('top-level failure');",
      "top-level failure",
    ],
  ]) {
    await t.test(
      `installed ${name} is an error, not absence or mismatch`,
      () => {
        const installation = fresh();
        installEnhancement(installation.modules, source);
        check(
          installation,
          `await assert.rejects(discover(), new RegExp(${JSON.stringify(expected)})); assert.deepEqual(messages, []);`,
        );
      },
    );
  }
  await t.test(
    "valid contract mismatch diagnoses and never invokes the factory",
    () => {
      const installation = fresh();
      installEnhancement(
        installation.modules,
        genericEnhancement
          .replace("contractVersion = 2", "contractVersion = 99")
          .replace(
            'events.push(["factory", config]);',
            'throw new Error("mismatched factory called");',
          ),
      );
      check(
        installation,
        `assert.deepEqual(Object.keys(await discover()), []); assert.equal(messages.length, 1); assert.match(messages[0], /contractVersion 99.*incompatible with 2.*base startup/);`,
      );
    },
  );
}
