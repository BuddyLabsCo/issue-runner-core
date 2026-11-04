# Terminal contract v2

Core exports Terminal and Enhancement contracts from `issue-runner-core/terminal`.
Both independent contract constants are `2`; neither comes from an npm version.
Companion terminal and enhancement packages must compile against these matching
contracts. There are no legacy overloads or supported mixed-contract combinations.
This requirement defines no npm release numbers or release order.

Core owns base Agent startup: create a Runner Tab, execute the configured command,
wait the configured delay, then establish native identity through a Session Probe.
Resume substitutes the exact saved native reference into the configured command.
Core retains Agent selection, handoff validation, Assignment metadata, recovery
wording, Operator Pause, and delivery policy. Terminal adapters own terminal I/O.
Enhancement discovery and activation are separate follow-up work; base operation
requires no enhancement. These repository checks do not establish native E2E acceptance.

## Build and identify a development artifact

Use Node.js 22.18.0 or later and npm 11 or later, including subsequent major versions.
The lockfile pins the TypeScript build dependency.
The CLI uses the source's `cac` and `yaml` parsers.
From the Core checkout:

```sh
npm ci --ignore-scripts
npm run typecheck
npm test
npm pack --json --pack-destination artifacts
```

`npm pack` builds the JavaScript and declarations through `prepack`. Its JSON
output records the filename, version, SHA-1 `shasum`, SHA-512 `integrity`, and
packaged files. Save that output alongside the tarball when handing it to Herdr;
the repository records the historical v1 artifact in
`artifacts/terminal-contract-v1.json`, which does not identify this v2 build. The tarball itself is a local build
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
import { realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { runCli, type CliOptions } from "issue-runner-core/cli";
import * as terminal from "./terminal.js";

const options: CliOptions = {
  commandName: "generic-terminal",
  commandVersion: "1.0.0",
  terminal,
  terminalPackageRoot: realpathSync(fileURLToPath(new URL(".", import.meta.url))),
  terminalCliEntry: realpathSync(fileURLToPath(import.meta.url)),
};
await runCli(options);
```

`CliOptions` requires `commandName`, `commandVersion`, `terminal`,
`terminalPackageRoot`, and `terminalCliEntry`. The last two are absolute real paths
to the executing terminal package root and its CLI entry file. This example places
the entry at the package root; adapt the root calculation to the package layout.
These identities anchor later enhancement discovery, including nested Core installs.
Locations and versions remain outside the recovery input hash.
`runCli(options)` returns `Promise<void>`.
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
List validation precedes terminal creation. Core validates the module's v2
contract and callable factory, then calls it once with the complete configured
`terminalPlugins` value with Core defaults applied. It rejects non-object results
and missing or non-callable terminal methods. Errors identify the command and
preserve useful causes. Validation and the cancellation checkpoint precede audit,
Run state and workflow effects. `--env` and terminal discovery are unsupported.
Core owns generic enhancement configuration; discovery and activation follow separately.

## Public types

```typescript
export const terminalContractVersion = 2 as const;
export const enhancementContractVersion = 2 as const;

// Opaque, plugin-instance-owned reference; Core must not inspect or persist it.
export type TabHandle = object;

export interface CreateTabOptions {
  cwd: string;
  env: Readonly<Record<string, string>>;
  label: string;
  submitKey: string;
  signal?: AbortSignal;
}

export interface TerminalPlugin {
  createTab(options: CreateTabOptions): Promise<{ handle: TabHandle; io: TerminalIO }>;
  execute(handle: TabHandle, command: string): Promise<void>;
  closeTab(tab: TabHandle): Promise<void>;
}

export interface TerminalPluginModule {
  readonly contractVersion: typeof terminalContractVersion;
  createTerminalPlugin(config: unknown): Promise<TerminalPlugin>;
}

export interface TerminalIO {
  read(): Promise<string>;
  submitText(text: string): Promise<void>;
  sendKeys(keys: readonly string[]): Promise<void>;
}

export type RequestRecovery = (assignmentId: string) => Promise<void>;

export interface EnhancementContext {
  readonly cwd: string;
  readonly env: Readonly<Record<string, string>>;
}

export interface Enhancement {
  startMonitoring(sessionref?: string): Promise<void>;
  waitUntilReady(): Promise<string>;
  onAssignment(assignment: { id: string; expectedFile: string }): void;
  stop(): Promise<void>;
}

export interface EnhancementModule {
  readonly contractVersion: typeof enhancementContractVersion;
  createEnhancement(
    io: TerminalIO,
    requestRecovery: RequestRecovery,
    context: EnhancementContext,
    config: unknown,
  ): Promise<Enhancement>;
}
```

A terminal module exports `contractVersion = 2` and an asynchronous
`createTerminalPlugin(config: unknown)` factory. Core validates all three methods
before workflow reads or mutations. Missing methods, mismatched versions, and
factory failures fail startup with command context. Core preserves terminal-owned
configuration values and validates its generic settings before calling the factory.
Factories with default parameters are supported; Core does not inspect arity.

`createTab` creates an owned Runner Tab in absolute `cwd`, overlays readonly `env`
on the inherited environment, and displays `label`. It binds `submitKey` (default
`Enter`) and accepts the Run cancellation `signal`. Invalid context or unsupported
environment application must fail rather than redirect silently. Creation does not
start an Agent. Its `handle` is plugin-instance-owned: Core never inspects, persists,
serializes, or reconstructs it. Native conversation identity is separate.

`execute(handle, command)` inputs the complete opaque command, then Right and Enter.
Resolution means command input was submitted, not command exit or Agent readiness.
Core supplies the configured start text unchanged. For resume, it substitutes every
literal `{sessionref}` with the exact saved reference, preserving whitespace and
replacement characters. The terminal receives neither an Agent selector nor a
separate native reference.

Bound `TerminalIO.read()` returns the current visible plain-text screen.
`submitText(text)` inputs the whole body, then Right and the creation-time submit key.
Core normalizes task text to LF while preserving Unicode, indentation, blank lines,
quotes, and literal characters. There is no per-call key override, expected-file
argument, or recovery-text argument. `sendKeys` sends ordered logical chords.
Unsupported chords reject rather than fall back. I/O alone grants neither command
execution nor tab closure to an enhancement.

After command submission, Core waits `terminalPlugins.agentStartDelay` seconds
(default ten). New conversations use the existing identity-only Probe and correction
flow. A retained Probe can establish identity before exact resume. Saved identities
reject empty refs, `latest`/`last`, and Runner Run/execution IDs. Base resume uses the
validated saved reference without a fresh Probe; the terminal cannot report identity.
Only native identity is persisted. All six purposes use the same stage coordinator.

Command failure can mean partial delivery. Core enters generic Operator Pause and
retains the tab. The operator must inspect it before continuing; Core will proceed
without replaying the uncertain command. Skip and cancellation retain resources.
Cancellation interrupts command and delay waits and prevents subsequent dispatch.
Create, task submission, and closure retain their existing bounds. No startup
readiness timeout or second pause mechanism is introduced.

`RequestRecovery` is a separate `(assignmentId: string) => Promise<void>` capability.
The enhancement factory takes bound I/O, this callback, cwd/env context, and unknown
configuration, in that order. `startMonitoring(sessionref?)`, repeatable
`waitUntilReady(): Promise<string>`, synchronous `onAssignment({ id, expectedFile })`,
and asynchronous `stop()` form the lifecycle. Assignment IDs distinguish dispatches
even when a handoff path is reused. Recovery wording stays in Core. These public
types allow companion packages to compile; this base migration does not activate
an enhancement or dispatch recovery callbacks.

`closeTab` targets only its owned logical tab. Foreign handles and backend errors
reject; a target known to be absent may close successfully. Closure does not prove
process or descendant settlement. Adapters use finite backend I/O bounds and do
not replay input or select replacement targets. Core queues its operations per
handle, checks cancellation when queued input begins, and permits independent tabs.

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
public entries. They exercise opaque control, bound I/O through the installed
execution wrapper, and the separate Assignment-aware recovery callback.
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
