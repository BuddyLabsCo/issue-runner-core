# Public integration contract

## Responsibilities and public entries

```typescript
// Terminal package: executable, command identity, process entry, terminal I/O.
// Core: CLI/workflow policy, Agent selection, Session Probe, native identities,
// handoff validation, Assignments, recovery wording, Operator Pause, and cleanup.
// Agent enhancement: native preflight, monitoring, readiness, recovery requests.
// Base startup requires no enhancement. No legacy or mixed-contract overloads.

// Terminal commands import runCli at runtime: keep Core in dependencies.
import { runCli, type CliOptions } from "issue-runner-core/cli";
import {
  terminalContractVersion, // 2; independent of npm package version
  enhancementContractVersion, // 2; independent of terminal contract version
} from "issue-runner-core/terminal";
// Type-only enhancement consumers can keep Core in devDependencies.
import type {
  TerminalPluginModule, TerminalPlugin, TerminalIO,
  CreateTabOptions, TabHandle, EnhancementModule, Enhancement,
  EnhancementContext, RequestRecovery,
} from "issue-runner-core/terminal";
// No root, source-internal, terminal/testing, or cli/testing public entry.
// Build/check commands and consumer verification: ../README.md#developing-core.
```

## Terminal CLI integration

```typescript
export interface CliOptions {
  commandName: string; // Executing terminal-owned command, used in help/errors.
  commandVersion: string; // Executing terminal package version.
  terminal: TerminalPluginModule; // Lazy factory; import must not create tabs.
  terminalPackageRoot: string; // Absolute real path to installed terminal package.
  terminalCliEntry: string; // Absolute real path to its executing CLI entry.
}
export function runCli(options: CliOptions): Promise<void>;

// Import is inert: no command, terminal creation, or signal listeners.
// Invocation reads process argv/cwd/env, owns operator and AbortController,
// installs SIGINT/SIGTERM abort listeners, and removes them in finally.
// Sets process.exitCode: 0 for success, 1 for handled failure/cancellation;
// never forces process termination. A pending terminal factory is awaited
// before the cancellation checkpoint. Reports/retained resources belong to Core.
// Help/version/init need no credentials or factory; init refuses overwrite.
// Version: <commandName> <commandVersion> (core <loadedCoreVersion>).
// For Runs: arguments, selection, config, credentials, prompts, and nonempty
// Issue List validation precede terminal creation. Module/version/factory and
// result-method validation plus cancellation precede audit and delivery effects.
// Command name, exact argv, and validated config bytes identify recovery input;
// command/Core versions and installation paths do not affect that hash.
// executeCli/CliDependencies/CliResult are internal. No --env/module-path option.
```

```typescript
// Minimal executable at the terminal package root; adapt root for a bin/ entry.
import { realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { runCli } from "issue-runner-core/cli";
import * as terminal from "./terminal.js";

await runCli({
  commandName: "generic-terminal",
  commandVersion: "1.0.0",
  terminal,
  terminalPackageRoot: realpathSync(fileURLToPath(new URL(".", import.meta.url))),
  terminalCliEntry: realpathSync(fileURLToPath(import.meta.url)),
});
```

## Terminal interfaces and bound I/O

```typescript
export const terminalContractVersion = 2 as const;
export type TabHandle = object;
// Opaque, plugin-instance-owned control reference. Core never inspects,
// serializes, persists, or reconstructs it. It is not a native conversation ref.

export interface TerminalPluginModule {
  readonly contractVersion: typeof terminalContractVersion;
  createTerminalPlugin(config: unknown): Promise<TerminalPlugin>;
}
// Core calls the factory once with the complete terminalPlugins mapping and
// generic defaults. Preserve adapter-owned fields; do not inspect factory arity.
// Version/method mismatches, invalid results, and factory failures fail startup
// with command context and useful causes; no workflow side effects precede them.

export interface CreateTabOptions {
  cwd: string; // Absolute working directory; never silently redirect.
  env: Readonly<Record<string, string>>; // Overlay on inherited environment.
  label: string;
  submitKey: string; // Effective Agent chord, defaulted to Enter by Core.
  signal?: AbortSignal; // Run cancellation combined with local revocation.
}
// Reject invalid context or unsupported environment application.
// Creation starts no Agent. Bind cwd/env/key/signal to this Runner Tab.

export interface TerminalPlugin {
  createTab(options: CreateTabOptions):
    Promise<{ handle: TabHandle; io: TerminalIO }>;
  execute(handle: TabHandle, command: string): Promise<void>;
  closeTab(tab: TabHandle): Promise<void>;
}
// execute: complete opaque shell command, then Right and Enter.
// Resolution means submitted, not process exit or Agent readiness.
// Core supplies start unchanged; resume replaces every literal {sessionref}
// with the exact saved native ref, preserving whitespace/replacement characters.
// No separate Agent selector or native identity is passed to the terminal.
// closeTab targets only the owned logical tab. Foreign handles/backend failures
// reject; a target known absent may succeed. Closure does not prove descendants
// settled. Never select a replacement target or replay uncertain input.
```

```typescript
export interface TerminalIO {
  read(): Promise<string>; // Current visible plain-text screen.
  submitText(text: string): Promise<void>; // Entire body, Right, bound submitKey.
  sendKeys(keys: readonly string[]): Promise<void>; // Ordered logical chords.
}
// Bound to one tab; no per-call key override, expected file, or recovery text.
// Core normalizes text to LF, preserving Unicode, quotes, indentation, blanks,
// and literal characters. Unsupported chords reject without fallback.
// I/O grants enhancements neither command execution nor tab-closure capability.
// Core serializes its operations per tab; independent tabs may run concurrently.
// Assignment changes/recovery stay queued until actual adapter input settles,
// including the adapter's own queue. Core timeouts do not release that ordering.
// Adapters check the creation signal when queued input begins: revoked work
// sends nothing. An already-started complete text/key sequence may settle.
// Keep finite backend I/O bounds. Revocation does not roll back existing effects
// or hide real backend errors. Core bounds terminal calls to 60 seconds, while
// cancellation stops its waits; neither proves underlying work was cancelled.
```

## Enhancement discovery and compatibility

Discovery uses the executing terminal command's verified global npm prefix, including when Core is nested. It loads modules; it creates no instances.

```mermaid
flowchart TD
    Run["Run: supplied real terminal package root and CLI entry"] --> Verify
    Verify{"Manifest name/location, command bin, real entry, launcher agree?"}
    Verify -- No --> Error["Fail startup with cause"]
    Verify -- Yes --> Layout["Unix: prefix/lib/node_modules + bin symlink<br/>Windows: prefix/node_modules + command.cmd"]
    Layout --> Agent{"Configured Agent can form issue-runner-agent-AGENT?"}
    Agent -- No --> Base["Base startup: delay and Session Probe"]
    Agent -- Yes --> Package{"Direct same-prefix package present?"}
    Package -- Absent --> Base
    Package -- Present --> Entry["Resolve Node import exports from that prefix"]
    Entry --> Valid{"Contained real package/file; import succeeds;<br/>positive safe-integer contractVersion;<br/>callable createEnhancement?"}
    Valid -- No --> Error
    Valid -- Yes --> Match{"contractVersion equals enhancementContractVersion?"}
    Match -- No --> Skip["Diagnostic; skip factory"] --> Base
    Match -- Yes --> Module["Pass selected module to shared Agent workflow"]
    Module --> Instance["Create one instance per Runner Tab"]
    Instance -- "Initialization failure" --> Cleanup["Report operational failure; attempt available cleanup"]
```

Scoped terminal packages and command names differing from package names are supported. Help, version, and init skip discovery. Project-local packages, task cwd, other prefixes, and Core's installation are not discovery anchors. Symlink escapes, dangling installs, malformed exports, and import failures are errors. Compatibility checks use contract versions, not npm versions. Module import executes top-level code; validation is not a sandbox.

## Enhancement interfaces

```typescript
export const enhancementContractVersion = 2 as const;
export type RequestRecovery = (assignmentId: string) => Promise<void>;
export interface EnhancementContext {
  readonly cwd: string;
  readonly env: Readonly<Record<string, string>>;
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
// Core passes the adapter's unchanged bound I/O, a SEPARATE recovery capability,
// the tab's cwd/env, and the entire terminalPlugins.enhancements object unchanged
// (default {}). Agent selection chooses the module, not a configuration namespace.
// Factory preflight completes before monitoring and command submission.
// Factories own resources until transferring an instance; a late transfer is
// cleanup-only. Invalid instances still receive stop() if it is callable.
```

```typescript
export interface Enhancement {
  startMonitoring(sessionref?: string): Promise<void>;
  waitUntilReady(): Promise<string>;
  onAssignment(assignment: { id: string; expectedFile: string }): void;
  stop(): Promise<void>;
}
// startMonitoring precedes command submission; resume receives the saved ref.
// waitUntilReady is repeatable. Return actual native identity; Core validates it,
// rejects empty/latest/last/Run/execution IDs, and requires exact resume equality.
// Core alone persists native identity; TabHandle never identifies a conversation.
// onAssignment is synchronous, immediately before input: fresh id for every task,
// continuation, correction, and applicable Probe, even if expectedFile repeats.
// Readiness markers and recovery input do not allocate Assignments.
// requestRecovery accepts only the current live Assignment; resolves after actual
// adapter submission and rejects real input errors. Stale requests succeed silently.
// Core retains expectedFile/recovery wording; acceptance invalidates the Assignment
// before persistence and closure. Readiness rejection alone does not revoke I/O.
// stop releases enhancement resources, not the interactive Agent, other tabs,
// or shared package infrastructure. Successful stop is idempotent; failed stop
// can retry. Concurrent stops share an attempt. Operational and cleanup errors
// are reported separately; prior readiness/input failures do not prevent cleanup.
// Skip, exit, and cancellation retain the interactive tab. Core validates all
// four methods before use. Readiness has no separate Core startup timeout.
```

## Lifecycle and failure flows

### Base startup and exact resume

```mermaid
%%{init: {"sequence": {"width": 220, "wrap": true}}}%%
sequenceDiagram
    participant Core
    participant Terminal
    Core->>Terminal: createTab(cwd, env, label, submitKey, signal)
    Terminal-->>Core: opaque handle and bound I/O
    Core->>Terminal: execute(handle, configured start or exact-ref resume)
    alt Command transport fails with uncertain delivery
        Core->>Core: Generic Operator Pause, retain tab
        Note over Core,Terminal: Inspect before continuing, never replay uncertain command
    end
    Core->>Core: Wait configured base delay (default 10 seconds)
    alt New conversation
        Core->>Terminal: io.submitText(identity-only Session Probe)
        Core->>Core: Observe assigned file, validate actual native ref
        opt Invalid Probe result
            Core->>Terminal: Correction with fresh Probe path
            Core->>Core: Observe and validate corrected file
        end
    else Saved conversation
        Core->>Core: Validate saved exact ref, no fresh Probe
    end
    Note over Core,Terminal: A retained Probe may establish identity before exact resume
    Core->>Terminal: io.submitText(task, correction, or saved continuation)
    Note over Core,Terminal: Missing files cause no reminders, handle native approvals in the tab
    Core->>Core: Independently verify handoff and persist accepted stage
    Core->>Core: Revoke automatic capabilities before closure
    Core->>Terminal: closeTab(owned handle)
    Note over Core,Terminal: Skip/cancellation retain interactive work, close failure retries same handle
```

### Enhanced startup, resume, and readiness retry

```mermaid
%%{init: {"sequence": {"width": 220, "wrap": true}}}%%
sequenceDiagram
    participant Core
    participant Terminal
    participant Enhancement as Agent Enhancement
    Core->>Terminal: createTab(cwd, env, label, submitKey, combined signal)
    Terminal-->>Core: opaque handle and unchanged bound I/O
    Core->>Enhancement: createEnhancement(io, requestRecovery, context, config)
    Enhancement-->>Core: Preflight complete, valid instance
    Core->>Enhancement: startMonitoring(saved ref if resuming)
    Core->>Terminal: execute(handle, start or exact-ref resume command)
    Note over Core,Terminal: Uncertain command delivery pauses, continuation never replays command
    Core->>Enhancement: waitUntilReady()
    alt Readiness rejects
        Core->>Core: Generic Operator Pause, keep capabilities active
        Core->>Enhancement: Enter retries waitUntilReady() on same instance/tab
        Note over Core,Enhancement: Keep completed preflight, monitoring, command submission
        Enhancement-->>Core: Actual native ref
    else Ready
        Enhancement-->>Core: Actual native ref
    end
    Core->>Core: Validate identity,<br/>require exact saved ref on resume
    Core->>Core: Persist new native identity before task dispatch
    Note over Core,Enhancement: Shared by implementation, Review, fixes, both repairs, documentation
```

### Assignment serialization, recovery, and stale requests

```mermaid
%%{init: {"sequence": {"width": 220, "wrap": true}}}%%
sequenceDiagram
    participant Core
    participant Terminal
    participant Enhancement as Agent Enhancement
    Core->>Core: Queue task, allocate fresh Assignment id
    Core->>Enhancement: onAssignment(id, expectedFile)
    Core->>Terminal: io.submitText(task)
    Enhancement->>Core: requestRecovery(current id)
    Core->>Core: Queue behind actual task adapter submission
    Terminal-->>Core: Task input settles
    Core->>Terminal: io.submitText(retained recovery wording)
    Terminal-->>Core: Recovery input settles (or real error rejects)
    Core-->>Enhancement: Resolve after submission (or reject real error)
    Core->>Core: Queue next Assignment or invalidate accepted Assignment
    opt Unknown, superseded, accepted, or revoked id
        Enhancement->>Core: requestRecovery(stale id)
        Core-->>Enhancement: Resolve without input or retries
    end
    Note over Core,Terminal: Timeout cannot release queue while adapter input remains pending
```

### Cancellation, revocation, and late initialization

```mermaid
%%{init: {"sequence": {"width": 220, "wrap": true}}}%%
sequenceDiagram
    participant Core
    participant Terminal
    participant Enhancement as Agent Enhancement
    Core->>Terminal: createTab with combined cancellation/revocation signal
    Core->>Enhancement: createEnhancement(...)
    alt Cancellation while factory is pending
        Core->>Core: Stop waiting, revoke automatic I/O and recovery
        Note over Core,Terminal: Retain interactive tab, queued input checks signal before starting
        alt Late instance transfers
            Enhancement-->>Core: Instance (callable stop captured even if invalid)
            Core->>Enhancement: stop() only, no monitoring or command
        else Late factory rejects
            Enhancement-->>Core: Initialization error
            Core->>Core: Report late operational failure
        end
    else Instance already active
        Enhancement-->>Core: Instance
        Core->>Core: Cancellation, terminal failure, or close preparation revokes capabilities
        Core->>Enhancement: stop()
        Note over Core,Terminal: Already-started complete input may settle, later input cannot start
    end
    Note over Core,Enhancement: Factory owns untransferred resources, cleanup failure reported separately
```

### Cleanup failure, retry, and closure

```mermaid
%%{init: {"sequence": {"width": 220, "wrap": true}}}%%
sequenceDiagram
    participant Core
    participant Terminal
    participant Enhancement as Agent Enhancement
    Core->>Core: Accept handoff,<br/>invalidate Assignment before persistence
    Core->>Core: Persist accepted stage,<br/>prepare close and revoke capabilities
    Core->>Enhancement: stop()
    alt Cleanup fails
        Enhancement-->>Core: Cleanup error
        Core->>Core: Report separately, retain interactive tab
        Core->>Enhancement: Retry stop() on later cleanup attempt
        Enhancement-->>Core: Cleanup succeeds
    else Cleanup succeeds
        Enhancement-->>Core: Stopped
    end
    Note over Core,Enhancement: Concurrent stops share attempt, later successful stops do nothing
    Core->>Terminal: closeTab(owned handle)
    alt Terminal close fails or remains unresolved
        Terminal-->>Core: Close error
        Core->>Core: Bounded retries then Operator Pause, retain accepted stage
        Core->>Terminal: Retry same handle only
    else Closed
        Terminal-->>Core: Closed
    end
    Note over Core,Terminal: No replay of accepted work or claim of process settlement
    Note over Core,Enhancement: Stage exit stops monitoring even when retaining tab for manual takeover
```
