# Terminal contract v1

Core exports the complete Terminal and Enhancement contracts from
`issue-runner-core/terminal`. Herdr and enhancement packages can compile against
the same installable artifact without importing Core internals. Both contract
versions are `1`, independent of the npm version `0.0.0-contract.1`.

This is the [contract milestone (#205)](https://github.com/BuddyLabsCo/issue-runner-core/issues/205)
within the [startup and monitoring delivery (#204)](https://github.com/BuddyLabsCo/issue-runner-core/issues/204).
Core validates all five terminal methods and passes the Agent identifier, submit key,
and Run signal when creating tabs for every role. Wrappers forward composite
startup without a Core readiness timeout and preserve all five submission
arguments. Core does not load enhancements or expose their installation/error state.

Core awaits `createTab` before composite `start` or `resume`. It saves a valid
returned native ref before dispatching business work. Only `undefined` from a new
start selects an identity-only Probe; resume must return the exact saved ref.
Readiness failures retain the Runner Tab for an operator-authorized retry on the
same handle. Cancellation reaches the plugin through the Run signal and retains
the Tab and Agent. Core adds no startup delay or readiness timeout.
Implementation and documentation handoffs supply `pr_title` and `pr_body`;
Review and repair schemas remain unchanged. No registry publication or real
Core/Herdr acceptance is implied.

## Build and identify a development artifact

Use Node.js 22.18.0 or later and npm 11 or later, including subsequent major versions.
The lockfile pins the TypeScript build dependency.
The CLI uses the source's `cac` and `yaml` parsers.
From the Core checkout:

```sh
npm ci
npm run typecheck
npm test
npm pack --json --pack-destination artifacts
```

`npm pack` builds the JavaScript and declarations through `prepack`. Its JSON
output records the filename, version, SHA-1 `shasum`, SHA-512 `integrity`, and
packaged files. Save that output alongside the tarball when handing it to Herdr;
the repository records the initial artifact in
`artifacts/terminal-contract-v1.json`. The tarball itself is a local build
output, not a published package. Repacking unchanged package contents with the
same toolchain reproduces its identity. Git attributes and compiler output use
LF line endings so Windows checkout defaults do not change packaged bytes.

Copy the full tarball to the terminal package repository and install it as a
runtime dependency:

```sh
npm install --save ../artifacts/issue-runner-core-0.0.0-contract.1.tgz
```

Use the actual tarball's portable relative or absolute path, including quotes
when it contains spaces. Keep its identity and the plugin lockfile together.
The full unpublished artifact supplies runtime code, public declarations, prompts,
init templates, and the manually installable handoff skill. A terminal command
must retain Core in `dependencies`, since it imports the CLI at runtime.
For a local tarball dependency, keep that tarball available at the recorded path
when packing and installing the terminal package; npm does not embed that file
inside the terminal tarball. Pack the terminal package and install it globally,
including with a custom prefix. Core is installed transitively, with no separate
sibling installation. Type-only enhancement consumers may use a dev dependency.
Neither consumer needs a Core source checkout.

Copy the full `skills/issue-runner-handoff` directory from the Core artifact to
each Agent's documented skill directory. Core does not install it automatically;
see [manual skill installation](../README.md#install-the-handoff-skill-manually).

```typescript
import type {
  CreateTabOptions,
  TabHandle,
  TerminalPlugin,
  TerminalPluginModule,
} from "issue-runner-core/terminal";
```

The same public entry supports the runtime import:

```javascript
import {
  terminalContractVersion,
  enhancementContractVersion,
} from "issue-runner-core/terminal";
```

There is no package-root entry, source-internal import, shared receiver, or
`issue-runner-core/terminal/testing` entry.

## Public CLI entry

Terminal packages own their executable, command identity and terminal I/O. Core
owns shared CLI and workflow policy. A command imports its existing lazy module
and calls the public entry once:

```typescript
import { runCli, type CliOptions } from "issue-runner-core/cli";
import * as terminal from "./terminal.js";

const options: CliOptions = {
  commandName: "generic-terminal",
  commandVersion: "1.0.0",
  terminal,
};
await runCli(options);
```

`CliOptions` contains exactly `commandName: string`, `commandVersion: string`,
and `terminal: TerminalPluginModule`. `runCli(options)` returns `Promise<void>`.
`executeCli`, `executeRun`, `CliDependencies`, and `CliResult` are internal and
are not exported by this subpath. There is no public testing entry.

Importing the CLI is inert: it starts no command, creates no terminal and installs
no process handlers. Calling `runCli` reads process argv, cwd and environment,
constructs the operator and AbortController, and wires SIGINT/SIGTERM to abort.
Its `finally` removes the listeners. Success sets `process.exitCode` to 0;
handled failures and cancellation set it to 1 without forced termination.
A pending factory is awaited before the cancellation checkpoint.
Existing reports and retained-resource behavior remain part of Core's workflow.

Help, usage errors and init follow-up commands use `commandName`. Version output
is `<commandName> <commandVersion> (core <loadedCoreVersion>)`, where the last
version belongs to the executing Core instance. Help/version/init need no
configuration credentials or terminal factory call. Init still creates Project
files and refuses overwrite.

For Runs, argument, selector, Project/configuration/credential and empty Issue
List validation precedes terminal creation. Core validates the module's v1
contract and callable factory, then calls it once with the complete configured
`terminalPlugins` value, or `{}` when omitted. It rejects non-object results
and missing or non-callable terminal methods. Errors identify the command and
preserve useful causes. Validation and the cancellation checkpoint precede audit,
Run state and workflow effects. `--env` and terminal discovery are unsupported.
Herdr owns generic optional enhancement discovery; Codex remains optional.

## Public types

```typescript
export const terminalContractVersion = 1 as const;
export const enhancementContractVersion = 1 as const;

// Opaque, plugin-instance-owned reference; Core must not inspect or persist it.
export type TabHandle = object;

export interface CreateTabOptions {
  cwd: string;
  env: Readonly<Record<string, string>>;
  label: string;
  agent: string;
  submitKey: string;
  signal?: AbortSignal;
}

export interface TerminalPlugin {
  createTab(options: CreateTabOptions): Promise<TabHandle>;
  start(tab: TabHandle, startCommand: string): Promise<string | undefined>;
  resume(
    tab: TabHandle,
    resumeCommand: string,
    sessionref: string,
  ): Promise<string>;
  submitText(
    tab: TabHandle,
    text: string,
    submitKey?: string,
    expectedFile?: string,
    recoveryText?: string,
  ): Promise<void>;
  closeTab(tab: TabHandle): Promise<void>;
}

export interface TerminalPluginModule {
  readonly contractVersion: typeof terminalContractVersion;
  createTerminalPlugin(config: unknown): Promise<TerminalPlugin>;
}

export interface EnhancementHost {
  read(): Promise<string>;
  submitText(text: string): Promise<void>;
  sendKeys(keys: readonly string[]): Promise<void>;
  requestRecovery(): Promise<void>;
}

export interface EnhancementContext {
  readonly cwd: string;
  readonly env: Readonly<Record<string, string>>;
}

export interface Enhancement {
  startMonitoring(sessionref?: string): Promise<void>;
  waitUntilReady(): Promise<string>;
  onAssignment(expectedFile: string): void;
  stop(): Promise<void>;
}

export interface EnhancementModule {
  readonly contractVersion: typeof enhancementContractVersion;
  createEnhancement(
    host: EnhancementHost,
    context: EnhancementContext,
    config: unknown,
  ): Promise<Enhancement>;
}
```

A terminal plugin's public module exports `contractVersion = 1` and an
asynchronous `createTerminalPlugin(config: unknown)` factory. Core passes the complete
`terminalPlugins` object unchanged, or `{}` when omitted.
Core validates the container without interpreting plugin-owned values or checking enhancement installation.
See [plugin configuration](configuration.md#installation-and-project-selection) for startup validation and recovery hashing.
The loader
accepts factories with default parameters; it does not inspect function arity.
Initialization errors reject startup. Core does not discover terminal packages.

`TabHandle` is an opaque capability owned by one initialized plugin instance.
Core must not inspect, serialize, persist, or reconstruct it. It is distinct
from the native Agent conversation reference.

`createTab` creates an owned Runner Tab in the absolute `cwd`, applies `env`
as a readonly overlay on the inherited environment, and uses `label` for display.
It receives the profile's unchanged opaque `agent`, effective configured
`submitKey` (default `Enter`), and optional Run `signal`. Invalid context or
unsupported environment application must fail rather than redirect silently.
Creating a tab does not start an Agent or prove readiness.

The final `start` and `resume` operations combine command execution with readiness.
`start` returns a native string ref when available, or `undefined` for Probe
fallback. `resume` receives the exact saved native ref and returns that ref.
Plugins must retain startup state so a readiness retry in the same tab does not
execute the command twice. Core wrappers impose no readiness timeout on these
operations; create, submission, and close bounds remain in place.

`submitText` transports complete canonical-LF text, preserving Unicode, blank
lines, indentation, quotes, and literal characters. Each call inputs the whole
body, sends mandatory Right, then sends the requested logical submit chord.
Enter is the default; Shift+Enter is also required. Unsupported chords reject
rather than fall back. The optional fourth and fifth arguments identify the
exact current handoff file and Core's recovery wording. Wrappers preserve them
positionally, including when optional preceding arguments are omitted. Transport
success does not prove Agent acceptance or completion.

For implementation, documentation, Review, Review fixes, CI repair, and conflict
repair, Core supplies both arguments on every task, continuation, and correction.
The exact unique absolute handoff path identifies the assignment. Continuation
retains that path; a correction replaces it with the newly persisted path.
Core renders a complete recovery message from a built-in template, asking the
Agent to continue unfinished work and use the assigned handoff protocol without
replaying the task. Plugins retain the current message for optional recovery.
Core still validates Agent-written handoffs and independent Git evidence;
assignment metadata and monitoring events cannot establish completion.

For every fallback Probe and Probe correction, Core also supplies the exact
assigned absolute Probe path and a recovery message from `prompts/probe-recovery.md`.
A correction uses the newly persisted path, replacing the superseded assignment.
The recovery message asks the Agent to continue the unfinished identity exchange
and write through its assigned Probe protocol. It forbids replaying the business
task or reporting business completion. Core does not request enhancement recovery.

`EnhancementHost` is bound to one tab: `read` reads terminal text, `submitText`
uses its Agent submit key, and `sendKeys` sends logical keys in order.
Argument-free `requestRecovery` asks the hosting plugin to submit the recovery
text retained for the current assignment. Core never calls it directly.
`EnhancementContext` supplies the tab's `cwd` and readonly `env`; the asynchronous
factory also receives opaque enhancement configuration.

`startMonitoring` optionally binds monitoring to a known native ref.
`waitUntilReady` is repeatable and returns the observed native string ref.
Synchronous `onAssignment(expectedFile)` replaces the active assignment.
Asynchronous `stop` must finish enhancement activity before the plugin closes
the owned tab. Run abort stops enhancement activity while preserving the tab
and Agent process. Core owns handoff validation and acceptance independently of
monitoring.

`closeTab` targets only the owned logical tab. Foreign handles, unknown targets,
and backend errors reject; a target known to be absent may close successfully.
Closing does not establish process or descendant settlement. Plugins use finite
backend I/O bounds and report actionable errors. They do not silently replay
input or select replacement targets. Core serializes operations on each handle
and may use independent handles concurrently.

The loader and injected-dependency boundary validate all five terminal methods
before workflow reads or mutations. Default-only exports, incorrect versions,
missing/non-callable methods, and factory rejection fail startup. The error names
the selected plugin and preserves its installation, import, compatibility, or
host-context failure. Core neither initializes unrelated plugins nor installs a
replacement.

## Verification limits and global installation

Run `npm run test:package` for the package checks; `npm test` includes them too.
These checks build and pack Core, then install the full tarball into a temporary
consumer directory to verify its public entries and declarations. They also pack
a private generic terminal command and install it in a custom npm global prefix,
with Core as its transitive runtime dependency. From a separate Launch Directory,
they invoke npm's generated command for help, combined versions, and init.
Core must register no executable. The factory throws if informational commands
or init try to create a terminal.

The checks compile representative CLI, Terminal and Enhancement consumers using
public entries. They exercise all terminal operations, five-argument forwarding
through the installed execution wrapper, and bound enhancement host methods.
No enhancement package is installed. They verify templates, bundled prompts,
and the manually installable `skills/issue-runner-handoff/SKILL.md` asset.
Temporary paths include spaces and are removed after the checks.
No registry publication, Herdr, Agent account or model call is required.

Product execution installs Herdr globally and brings Core transitively, including
with supported custom npm prefixes. The eventual registry command is:

```sh
npm install -g issue-runner-herdr
issue-runner-herdr run --project my-project --parent 42
```

Registry publication is still future work; use built tarballs for development.
Project-local/npx product execution is outside the agreed support policy.
Project configuration remains `<launch-directory>/<project>/config.yaml`.
Final candidate production and evidence remain completion requirements of #223;
real-terminal acceptance remains in #15 and #198.

The required full-product CI matrix is Ubuntu and Windows, currently pinned to
Node.js 22.18.0 and npm 11.6.2. Supported versions have no upper major bound.
Paths and child processes here use portable Node APIs;
portable code does not establish tested macOS behavior. Package tests do not
establish actual terminal delivery, native Agent behavior, or joint acceptance.
