# Issue Runner design

Agreed direction as of 2026-10-29 (Asia/Shanghai).
This document is the shared design proposal for `issue-runner-core` and its
execution environment plugins. It describes intended behavior, not an
implemented or published product.

## Goal

Reuse sandcastle-runner's workflow control and all existing workflow behavior
except Agent-session Operator Pause. Replace its Sandcastle-managed,
non-interactive Agent execution with native interactive Agent CLIs hosted by an
external terminal multiplexer.

The operator runs one `issue-runner` command in the multiplexer, sees Agent
conversations in other terminals, and can interrupt, diagnose, instruct, and
continue those same conversations directly.

Runner dispatches work and receives explicit file handoffs. It does not build a
chat interface or infer task completion from Agent-specific screen layouts.
The new execution path does not require Sandcastle.

## Repositories and packages

| Repository / intended package | Responsibility |
| --- | --- |
| `BuddyLabsCo/issue-runner-core` / `issue-runner-core` | Shared workflow, the `issue-runner` executable, configuration, file handoffs, and public environment plugin contracts |
| `BuddyLabsCo/issue-runner-herdr` / `issue-runner-herdr` | Herdr implementation of those terminal contracts |
| Future environment plugins | Other multiplexer implementations, such as tmux, using the same contracts |

Only the two named repositories are in the initial scope. A tmux plugin is a
future example, not part of this bootstrap.

```text
User: issue-runner run --env herdr
                  |
        issue-runner-core CLI
                  |
       load installed environment plugin
                  |
        shared workflow and Agent execution
                  |
        public terminal operation contracts
                  |
        issue-runner-herdr implementation
                  |
        Herdr-owned interactive terminal
```

Core defines the contracts and loads the selected plugin at runtime. A plugin
implements those contracts and may depend on Core's public types. Core does
not have a compile-time dependency on any specific environment plugin.

## Existing behavior to preserve

The source behavior is the existing
[sandcastle-runner](https://github.com/BuddyLabsCo/sandcastle-runner) workflow.
The initial source baseline discussed here is
`0adf499bf69217b56256ca2affb1c0dca0894110`; migration must identify its actual
source revision and account for subsequent upstream changes.

Preserve:

- Project configuration, issue discovery, reservations, selection, batches, and
  concurrency rules.
- Branch and Worktree preparation, independent Git verification, and cleanup
  guarantees.
- Implementation, Review and review fixes, CI repair, conflict repair, and
  Documentation Maintenance.
- Pull Request publication, required-check handling, integration policy,
  completion verification, and ticket closure.
- Prompt construction, result schemas, automatic retry budgets and delays,
  structured-output correction, and required same-conversation continuation.
- Audit records, Recovery Snapshots, cancellation, and every non-Agent
  Operator Pause.

The intentional workflow exception is Agent-session Operator Pause: operators
handle the native interactive conversation directly instead of entering the
existing pause/kill/manual-resume/acknowledge sequence.

Do not remove unrelated retries or failure behavior as a side effect of
changing the execution transport. Do not replace a schema-validated result or
Verified Handoff with an operator message or terminal status.

## One CLI with installed environment plugins

`issue-runner-core` owns the `issue-runner` executable. Environment plugins do
not each publish a competing runner executable.

Core accepts an environment name without a built-in `herdr`/`tmux` enumeration.
The initial discovery rule is:

```text
--env <name> -> installed package issue-runner-<name>
```

Core validates the name, locates the selected installed package, loads its
public entry point, and validates the plugin contract and compatibility before
starting workflow side effects. Only the selected plugin needs to load.

A missing plugin produces an actionable error. Core does not automatically
install packages during `run`.

The intended installation and execution examples are:

```sh
npm install --save-dev issue-runner-core issue-runner-herdr
npx issue-runner run --env herdr
```

```sh
npx --package=issue-runner-core --package=issue-runner-herdr issue-runner run --env herdr
```

These package names are design targets, not a claim of npm publication or name
reservation. Repository privacy does not decide future npm distribution.

The plugin loader must support the selected local installation and `npx`
execution layouts. Having an executable on `PATH` does not by itself locate a
Node module. Resolution must cover Core's actual execution environment and
the selected plugin installation, including npm's execution cache. Global and
mixed installation layouts require explicit validation before support is
claimed.

## Terminal plugin responsibility

The public interface should cover the operations needed by shared execution:

| Operation | Required meaning |
| --- | --- |
| Create a terminal | Use the assigned cwd, environment, and label; return an unambiguous handle without relying on current UI focus |
| Start a command | Execute the configured program and argument list in the assigned terminal, with backend-specific quoting handled by the adapter |
| Submit text | Deliver literal text and its submission action, including multiline prompt handling |
| Send terminal keys | Provide the small set of terminal controls needed by execution and cancellation |
| Observe lifecycle | Report terminal existence, relevant process/connection state, and closure or failure without pretending these are Agent completion |
| Close a terminal | Target the intended Runner-created terminal and report failure or uncertainty |

These are semantic requirements, not finalized TypeScript method signatures.
Herdr tabs/panes and tmux windows/panes can map to the same logical terminal
handle; their native object names need not leak into shared workflow code.

Generic terminal content/title reads may be available for startup checks or
diagnostics. They are not required as an Agent-specific task-completion
classifier.

The plugin does not decide issue eligibility, create Worktrees, select models,
construct prompts, interpret result JSON, or implement an Agent brand allowlist.
It need not use Herdr's Agent-specific start/status APIs.

## Agent configuration without a brand allowlist

Configure how to start and resume a native interactive CLI. Example shape only:

```yaml
agents:
  implement:
    start:
      - my-agent
    resume:
      - my-agent
      - "--resume"
      - "{session_ref}"
```

`my-agent` and its arguments are illustrative. Users supply the real command,
model/options, storage configuration, or a wrapper appropriate to their CLI.
Core handles the common configuration contract rather than a fixed list of
supported Agent products.

Starting a command and submitting a prompt are separate operations. Start and
resume commands are not required to accept a `{prompt}` argument. Core builds
the prompt and submits it through the terminal interface after startup
readiness has been established.

A still-running conversation can receive another assigned prompt without
restarting. A closed conversation is reopened using the configured resume
command when the workflow requires its original context.

## Session Probe file handoff

When a native recovery reference is needed, send a Session Probe to the
interactive Agent. Ask it to obtain its real native session ID or session-file
reference using its available tools and write it to an assigned file.

```text
session.json.tmp -> close completed file -> rename to session.json
```

Example payload:

```json
{
  "probe_id": "<assigned-probe-id>",
  "session_ref": "<actual-native-session-reference>"
}
```

Core validates the response and persists its association with the Run,
conversation role, Worktree, terminal, and required storage/configuration.
`session_ref` is opaque: Core need not parse a particular vendor's ID format.
Subsequent resume commands receive that saved value.

The reference must identify the real native conversation. A Runner-generated
probe ID is not automatically a native session ID. Where a CLI supports
preassigned identity, or a configured launcher/hook/wrapper can supply it, that
mechanism can establish the reference through the same contract without
requiring model guesswork. These are alternatives, not mandatory extra setup
for every Agent.

Returning a reference and successfully restoring its original context are
separate checks. Restoration must be validated for the selected CLI
configuration; matching a string alone is insufficient.

## Task result file handoff

For each substantive invocation or correction, Core assigns fresh absolute
temporary and final result paths and appends the handoff instructions to the
existing task prompt:

1. Complete the requested work, tool operations, checks, and required commits.
2. Write the existing required result JSON to the assigned `.json.tmp` path.
3. Close the completed file and rename it to the assigned `.json` path.
4. Treat publication as this invocation's final handoff: do not continue
   modifying the Worktree or launching work for this invocation afterward.

Temporary and final files belong in the same directory. The submission must
use a real rename, not a cross-filesystem copy presented as equivalent.

Core ignores temporary files. It checks the final path, reads the payload, and
applies existing result-schema and independent Git verification. Final-file
existence is the submission signal, not automatic successful delivery.

Use distinct paths for each Run, task, operation, and invocation/correction,
including repeated turns in one native conversation. Associate results with
their assigned invocation and consume an accepted result once. The existing
business result payload need not change solely to carry transport metadata.

File notifications may accelerate observation, but startup reads and periodic
checks must also find completed handoffs after missed events or reconnection.

No Core-owned screen recognizer, `working`/`idle` classifier, or native
turn-completion hook is required to declare this protocol's result submission.
File submission does not prove process exit or descendant cleanup. Keep those
lifecycle guarantees where the workflow requires them, especially before
cleanup, replacement execution, or concurrent work on the same Worktree.

## Operator experience and conversation lifetime

The operator starts Runner in the first terminal. Core dispatches Agent work
into additional terminals, which remain ordinary interactive CLIs.

The operator can inspect and interrupt an active conversation, fix its
instructions or answer a question, and let it complete the assigned file
handoff. There is no Agent-session Operator Pause acknowledgement in Runner.

Keep native conversation identity and terminal identity separate. The terminal
is a UI/process location; the native reference identifies context that may be
resumed elsewhere.

Preserve the original implementation and Review conversations across the
rounds that need them. Receiving one intermediate result does not automatically
mean the conversation is disposable. Close Runner-owned terminals when their
workflow lifetime ends and the required execution/resource checks are met.

## Open execution details

The following must be specified and proven during implementation:

- Startup readiness before sending the first probe or prompt. File handoff
  solves result submission, not readiness to receive input. A fixed sleep
  alone is insufficient.
- Input ordering when the operator is typing or has interrupted a turn, and
  when existing automatic continuation/correction becomes eligible.
- The exact replacement for every removed Agent-session pause branch,
  including blocked results, timeout, missing output, crash, and exhausted
  recovery. Preserve the remaining policy; do not silently turn these into
  success, unlimited retries, or a new hidden pause UI.
- Exact restoration using the correct native reference, Worktree, environment,
  storage root, and model/options. Do not substitute an ambiguous "latest"
  conversation in concurrent Runs.
- Terminal closure, process settlement where required, and the lifetime of
  temporary configuration files while externally owned sessions remain alive.
- Recovery of assigned probes/results after Runner or multiplexer interruption,
  without duplicate dispatch or accepting a stale result.
- Public plugin exports, interface compatibility, installation resolution, and
  packaging across the supported runtime/platform combinations.

These are execution-contract details, not permission to redesign issue,
Review, publication, CI, integration, or ticket-closure behavior.

## Initial delivery and acceptance

The initial delivery is this design and the two private repositories. Do not
infer that executable packages, a plugin registry, a plugin installer, or a
third-party terminal implementation already exist.

Implementation should extract the reusable workflow and its behavioral tests,
define the minimal public contracts, then connect the Herdr plugin.

Acceptance requires:

- Existing workflow scenarios retain their outcomes except the explicitly
  removed Agent-session Operator Pause behavior.
- Core plus the selected plugin works through local installation and the
  documented multi-package `npx` entry point.
- A configured interactive CLI starts, receives a separately submitted probe
  and task, permits manual intervention, and submits valid file handoffs.
- Exact conversation restoration recalls prior context, including a
  multi-round implementation/Review/fix scenario.
- Partial, malformed, stale, duplicate, and missing files do not advance an
  invocation incorrectly.
- Cancellation, process failure, restart, and concurrent tasks preserve
  resource ownership, targeting, and existing verification guarantees.

## Related evidence

- [Source workflow specification](https://github.com/BuddyLabsCo/sandcastle-runner/blob/0adf499bf69217b56256ca2affb1c0dca0894110/docs/specs/v1-orchestration.md)
- [Multiplexer feasibility research](https://github.com/BuddyLabsCo/sandcastle-runner/pull/305)
- [Coding Agent session-resume research](https://github.com/BuddyLabsCo/sandcastle-runner/pull/307)

The research supports feasibility, not a runtime compatibility promise.
This document's later agreed decisions supersede earlier proposals to maintain
an Agent-specific screen-state detector in Core or to provide a separate CLI
for each multiplexer.
