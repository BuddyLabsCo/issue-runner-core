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
Core discovers optional enhancements from the executing terminal's verified global
prefix and orchestrates them through internal dependencies. Base operation requires no enhancement.
These repository checks do not establish native E2E acceptance.

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
npm install --save ../artifacts/issue-runner-core-0.1.0.tgz
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
Core verifies these identities before enhancement discovery, including nested Core installs.
Locations and versions remain outside the recovery input hash.
`runCli(options)` returns `Promise<void>`.
`executeCli`, `executeRun`, `CliDependencies`, and `CliResult` are internal and
are not exported by this subpath. There is no public testing entry.

Importing the CLI is inert: it starts no command, creates no terminal and installs
no process handlers. Calling `runCli` reads process argv, cwd and environment,
constructs the operator and AbortController, and wires SIGINT/SIGTERM to abort.
Its `finally` removes the listeners. Success sets `process.exitCode` to 0;
handled failures and cancellation set it to 1 without forced termination.
A pending terminal-plugin factory is awaited before the cancellation checkpoint.
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
Core owns enhancement discovery, configuration, and lifecycle orchestration.
There is no public module-path option.

## Installed enhancement discovery

For Runs, Core validates the terminal package's manifest name against its installed
location, the `commandName` bin declaration, and the supplied real CLI entry.
It requires a matching launcher in that prefix. Supported layouts are
`<prefix>/lib/node_modules` with a Unix `bin/<command>` symlink and
`<prefix>/node_modules` with npm's Windows `<command>.cmd` shim.
The package name and executable may differ; scoped terminal packages are supported.
Help, version, and init do not perform discovery.

For each configured Agent, Core looks for `issue-runner-agent-<agent>` directly
in the verified global modules directory. An absent package retains base startup.
An opaque Agent identifier that cannot form this package name also retains base startup.
Node resolves the package's import entry from that prefix, including `import` exports.
The resolved package and entry must remain inside the expected same-prefix package;
path traversal, symlink escapes, and dangling installations fail startup.
Core's own installation, task cwd, project-local packages, and other npm prefixes
are not discovery anchors. There is no configurable external package path.

The imported module must export a positive safe-integer `contractVersion` and
callable `createEnhancement`. A different valid enhancement contract emits a
command diagnostic and skips the factory, retaining base startup. Malformed
exports, invalid entries, and import failures remain errors. Compatibility uses
`enhancementContractVersion`, independently of the terminal contract and npm version.
Importing a module can execute its top-level code; validation is not a sandbox
or a pre-import metadata check.

Discovery returns modules, without creating instances. Core passes each selected
module and the entire `terminalPlugins.enhancements` options object to the shared Agent workflow.
Factory and lifecycle failures retain the existing error reporting and tab cleanup
rules below. Herdr supplies terminal behavior and installation identity; it does
not discover or orchestrate enhancements. Companion contracts remain v2, with no
publication requirement or prescribed release order.

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

Without an enhancement, Core waits `terminalPlugins.agentStartDelay` seconds
(default ten) after command submission. New conversations use the existing identity-only Probe and correction
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
even when a handoff path is reused. Recovery wording stays in Core.

Core creates one instance per Runner Tab, passing the adapter's unchanged bound I/O,
the callback, cwd/env, and the shared `terminalPlugins.enhancements` object unchanged,
including the default `{}`. Agent selection chooses the module, not a configuration namespace. Core
validates all four methods before use. An invalid instance's callable `stop` is
still attempted; initialization and cleanup errors are reported separately.

## Enhanced orchestration and recovery

A resolved module replaces base delay/Probe with preflight, monitoring, command
submission, and readiness. Core validates the returned native reference before
persisting it or dispatching work; resumed references must match exactly.
Implementation, Review, Review fixes, both repairs, and documentation share this path.
The CLI wires modules resolved by the discovery adapter into this shared path.
Discovery does not call factories or cache instances across Runner Tabs.

Readiness rejection enters generic Operator Pause. Enter retries readiness on the
same instance and tab, preserving completed preflight, monitoring, and command
submission. Pause alone leaves capabilities active. Uncertain command delivery is
never replayed on continuation. Skip, exit, and cancellation retain the interactive tab.

Every task, continuation, correction, and applicable Probe gets a fresh Assignment
ID, even when its expected file repeats. Core retains its expected file and recovery
text, and calls synchronous `onAssignment` immediately before task input. Readiness
markers and recovery input do not allocate Assignments.

`requestRecovery(id)` accepts only the current live Assignment on that instance.
It submits the retained wording and resolves after adapter submission; real input
errors reject. Unknown, superseded, accepted, or revoked Assignments succeed without
input or retries. Assignment changes and recovery share Core's per-tab queue until
actual adapter input settles, including time waiting in the adapter's own queue.
A Core timeout cannot release that sequencing while underlying input remains pending.
Handoff acceptance invalidates the Assignment before persistence and closure.

Core gives each tab a creation-time cancellation signal combining Run cancellation
and local revocation. Cancellation, terminal failure, and close preparation revoke
bound automatic I/O and recovery before enhancement cleanup. Adapters must check
this signal when queued input starts: revoked work performs no input. Cancellation
allows an already-started complete text/key sequence to settle; subsequent input
cannot begin. This does not roll back effects or suppress real backend failures.
Ordinary enhancement reads and input remain adapter operations, not Core forwarding.

Cancellation during a pending enhancement factory returns without waiting for it.
Core observes late settlement, reports late failure, and stops any transferred
instance without monitoring or executing commands. The factory remains responsible
for resources it never transfers.

Explicit close revokes capabilities, awaits successful enhancement cleanup, and
then closes only the owned tab. Cleanup failure preserves the tab. Concurrent stops
share one attempt; successful cleanup is idempotent and failed cleanup can retry.
Historical readiness or input failures do not poison cleanup. Stage exits stop
monitoring even when retaining the interactive Agent for manual takeover; residual
tab cleanup follows successful enhancement cleanup. An instance must not terminate
an interactive Agent, another tab, or package-owned shared infrastructure.

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
Enhancement package fixtures exercise both global layouts, nested Core, decoys,
launcher/entry containment, mismatch fallback, and import/export failures. A valid
module reaches the shared workflow with an independent instance per tab.
The checks also verify templates, bundled prompts,
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
