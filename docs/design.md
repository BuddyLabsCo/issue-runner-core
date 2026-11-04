# Issue Runner design

Original proposal agreed on 2026-10-29 (Asia/Shanghai).
Command ownership below incorporates the accepted #223/#228 cutover.
This document is the shared design proposal for `issue-runner-core` and its
execution environment plugins. It describes intended behavior, not an
implemented or published product.

## Goal

Reuse sandcastle-runner's workflow control and all existing workflow behavior
except Agent-session Operator Pause and Runner-recorded Agent conversation
logs. Replace its Sandcastle-managed,
non-interactive Agent execution with native interactive Agent CLIs hosted by an
external terminal multiplexer.

The operator runs a terminal-owned command such as `issue-runner-herdr` in the multiplexer, sees Agent
conversations in other terminals, and can interrupt, diagnose, instruct, and
continue those same conversations directly.

Runner dispatches work and receives explicit file handoffs. It does not build a
chat interface or infer task completion from Agent-specific screen layouts.
The new execution path does not require Sandcastle.

## Repositories and packages

| Repository / intended package | Responsibility |
| --- | --- |
| `BuddyLabsCo/issue-runner-core` / `issue-runner-core` | Shared CLI/workflow policy, configuration, file handoffs, and public terminal contracts |
| `BuddyLabsCo/issue-runner-herdr` / `issue-runner-herdr` | The `issue-runner-herdr` command, terminal I/O, and generic optional enhancement discovery |
| Future environment plugins | Other multiplexer implementations, such as tmux, using the same contracts |

Only the two named repositories are in the initial scope. A tmux plugin is a
future example, not part of this bootstrap.

```text
User: issue-runner-herdr run
                  |
        issue-runner-core/cli runCli
                  |
       validate supplied lazy terminal module
                  |
        shared workflow and Agent execution
                  |
        public terminal operation contracts
                  |
        issue-runner-herdr implementation
                  |
        Herdr-owned interactive terminal
```

Core defines the contracts and validates the supplied module at runtime. A terminal
package implements those contracts and depends on Core's public CLI and types. Core does
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
- Prompt construction, result schemas, non-Agent retry budgets and delays,
  structured-output correction, and required same-conversation continuation.
- Audit records, Recovery Snapshots, cancellation, and every non-Agent
  Operator Pause.

The intentional workflow exception is Agent-session Operator Pause: operators
handle the native interactive conversation directly instead of entering the
existing pause/kill/manual-resume/acknowledge sequence.

Runner also stops recording Agent conversation transcripts as log files.
Operators inspect the native interactive conversations directly. This removes
duplicate transcript capture, not workflow audit records, Recovery Snapshots,
or the native session storage needed for resume.

Do not remove unrelated retries or failure behavior as a side effect of
changing the execution transport. Do not replace a schema-validated result or
Verified Handoff with an operator message or terminal status.

## Terminal-owned commands with shared CLI policy

The original proposal assigned the executable and plugin discovery to Core.
The accepted #223/#228 decision assigns each terminal package its command and
keeps shared CLI/workflow policy in Core. The earlier local/npx proposal was
superseded by global installation, including supported custom npm prefixes.

A terminal command imports `runCli` from `issue-runner-core/cli` and supplies
its canonical command name, package version, and existing `TerminalPluginModule`.
Core registers no executable, discovers no terminal packages, and accepts no
`--env` option. Importing the CLI is inert. Calling it owns process arguments,
cwd/environment, OperatorIO, cancellation wiring and exit status.
Help/version/init do not create a terminal. Combined version output identifies
both the command and the executing Core instance.

Core validates run arguments and Project configuration before invoking the
factory once with the complete `terminalPlugins` value. It validates the returned
methods and checks cancellation before audit or workflow effects. Terminal and
enhancement v1 contracts and lifecycle remain unchanged. Herdr owns generic
optional enhancement discovery, with Codex optional and unchanged.

Recovery uses one identity for execution, Batch, and maintenance checkpoints and
associations: the canonical command name, exact argument array, and configuration
bytes validated at startup. A command rename, argument change, or configuration
change starts a new Run without adopting old progress. Command and Core versions,
installation prefix, and executable path are excluded, so package upgrades alone
preserve compatible recovery. Matching progress still requires its original
working context. Cancellation retains unfinished resources; recovery failure
offers explicit restart or exit, and restart retains the old resources.

Install the terminal package globally with Core as a transitive runtime dependency:

```sh
npm install -g issue-runner-herdr
issue-runner-herdr run --project my-project --parent 42
```

These package names remain distribution targets, not a claim of publication.
For unpublished builds and manual handoff skill installation, follow the
[package-consumer instructions](terminal-contract.md#build-and-identify-a-development-artifact).

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
    agent: my-agent
    start: 'my-agent --interactive'
    resume: 'my-agent --resume "{sessionref}"'
```

`my-agent` and its arguments are illustrative. Users supply the real command,
model/options, storage configuration, or a wrapper appropriate to their CLI.
Core handles the common configuration contract rather than a fixed list of
supported Agent products.

Starting a command and submitting a prompt are separate operations. Start and
resume commands are not required to accept a `{prompt}` argument. Core builds
the prompt and submits it through the terminal interface after startup
readiness has been established.

Within one stage, Core submits further prompts to its owned Runner Tab. Recovery
and later stages open a fresh Runner Tab, then await composite resume with the
exact saved native ref. Core does not adopt surviving live tabs. Startup and
readiness retries reuse the created handle; plugins must avoid launching an
Agent twice. Cancellation retains the Tab and Agent. Other terminal operations
remain bounded, while composite readiness has no Core timeout or startup sleep.

## Session Probe file handoff

Establish a native reference for each conversation so it can be identified in
stage output and resumed if its terminal is closed. When the reference is not
already supplied by the configured launcher, send a Session Probe to the
interactive Agent. Ask it to obtain its real native session ID or session-file
reference using its available tools and write it to an assigned file.

```text
session.json.tmp -> close completed file -> rename to session.json
```

Example payload:

```json
{
  "sessionid": "<actual-native-session-reference>"
}
```

Core associates the response with its execution and conversation role through the
persisted unique output path. The response does not echo application IDs or its
own path. All fallback Probes return only `sessionid`. Implementation and
documentation business handoffs supply `pr_title` and `pr_body`, generated after
reading the Issue and repository PR conventions. Review and repair handoffs omit them.

Core validates the response and saves the native identity before business dispatch.
`sessionid` is opaque: Core does not parse a particular vendor's ID format.
Subsequent resume commands receive that saved value.

The reference must identify the real native conversation. Application IDs cannot
establish native identity; Core does not generate a separate Probe ID. Where a CLI supports
preassigned identity, or a configured launcher/hook/wrapper can supply it, that
mechanism can establish the reference through the same contract without
requiring model guesswork. These are alternatives, not mandatory extra setup
for every Agent.

Returning a reference and successfully restoring its original context are
separate checks. Restoration must be validated for the selected CLI
configuration; matching a string alone is insufficient.

## Task result file handoff

The [accepted handoff decision](https://github.com/BuddyLabsCo/issue-runner-core/issues/5#issuecomment-6497094791)
supersedes earlier result payloads. Operators manually install the bundled
[`issue-runner-handoff` skill](../skills/issue-runner-handoff/SKILL.md), following
the [README](../README.md#install-the-handoff-skill-manually). Built-in
purpose-specific prompts invoke the skill as the final action after the assigned
task is complete. Its sole argument is the assigned absolute
final JSON output path. Result schema instructions live in the skill rather
than being repeated in each task prompt.

For each substantive invocation or validation correction, Core assigns
a fresh unique path under
`<runner-working-directory>/<project-name>/handoffs/<issue-number>-<phase>-<timestamp>.json`.
The skill writes exactly `outcome`, `summary`, `commits`, and `findings_file`.
Execution outcomes are `committed` and `no_change`; Review outcomes are
`passed` and `findings`. Commit entries use full Git SHAs and messages.

The skill writes `<handoff-path>.tmp` in the final file's directory, validates
the JSON, closes the temporary file, then atomically renames it to the final
path as its last step, replacing any existing final file. An operator can
explicitly reinvoke the skill in the original conversation with the same
assigned path to correct that invocation. Core never reuses that path for a
different invocation.

Task completion, required checks and commits, Review write restrictions,
and remote-operation restrictions belong in the purpose-specific prompts.
The shared skill owns the result schema, truthful reporting, atomic publication,
and the requirement to stop all work after publication. Runner owns push, PR, integration, and tracker
operations.

Core ignores temporary files. It checks the final path, reads the payload, and
applies existing result-schema and independent Git verification. Final-file
existence is the submission signal, not automatic successful delivery.

Use distinct paths for each Run, task, operation, and invocation/correction,
including repeated turns in one native conversation. Associate results with
their assigned invocation and consume an accepted result once.

File notifications may accelerate observation, but startup reads and periodic
checks must also find completed handoffs after missed events or reconnection.

No Core-owned screen recognizer, `working`/`idle` classifier, or native
turn-completion hook is required to declare this protocol's result submission.
File submission and tab close do not prove process exit or descendant cleanup.

## Operator experience and conversation lifetime

The operator starts Runner in the first terminal. Core dispatches Agent work
into additional terminals, which remain ordinary interactive CLIs.

The operator can inspect and interrupt an active conversation, fix its
instructions or answer a question, and let it complete the assigned file
handoff. There is no Agent-session Operator Pause acknowledgement in Runner.

Keep native conversation identity and terminal identity separate. The terminal
is a UI/process location; the native reference identifies context that may be
resumed elsewhere.

Preserve the original implementation and Review conversations across the rounds that need them. Close each accepted stage's Runner Tab before its successor starts. A later fix or Review opens a new tab and resumes the exact saved conversation after composite resume readiness.

When an Issue completes successfully, close its residual owned Runner Tabs and remove its owned Worktrees, local branches, and assigned Probe/handoff final and temporary files, including superseded corrections. Stage completion alone never deletes these files. Retain unfinished execution resources and native conversation histories. Keep workflow audit and recovery records. Checkpoint completed cleanup actions so recovery retries only unfinished actions.

Targeted tab close completes Runner's termination responsibility without process, descendant, or external-writer settlement. Do not close the operator's Runner terminal or another Issue's tabs. A rejected or unresolved close remains incomplete cleanup. [Cleanup configuration and recovery](configuration.md#successful-issue-cleanup) describe retries and retained evidence.

### Stage output

Keep the existing per-Issue stage output and add the native conversation
reference as `sessionid`, for example:

```text
Issue #43 implement sessionid=<implementation-ref> handoff=<implement-path>
Issue #43 review round 1 sessionid=<review-ref> handoff=<review-path>
Issue #43 fix review round 1 sessionid=<implementation-ref> handoff=<fix-path>
Issue #43 review round 2 sessionid=<review-ref> handoff=<next-review-path>
```

Review and fix progress identify the round, including during recovery and handoff corrections.
The fix round reports the same implementation reference even if it resumes in
a new tab. Use the validated opaque `session_ref`, not a terminal handle,
application ID, or an ambiguous latest-session reference. While
the native reference is being established, report `sessionid=pending`; emit
the stage with its actual reference once available. Stages without an
associated Agent conversation report `sessionid=n/a`.

## Open execution details

The following must be specified and proven during implementation:

- Startup readiness before sending the first probe or prompt. File handoff
  solves result submission, not readiness to receive input. A fixed sleep
  alone is insufficient.
- Input ordering when the operator is typing or has interrupted a turn, and
  when existing automatic continuation/correction becomes eligible.
- Detecting an open terminal whose Agent has exited, and recovering without
  submitting prompts to its shell or starting duplicate execution.
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
  removed Agent-session Operator Pause behavior and Agent transcript capture.
- Core plus the selected plugin works through local installation and the
  documented multi-package `npx` entry point.
- A configured interactive CLI starts, receives a separately submitted probe
  and task, permits manual intervention, and submits valid file handoffs.
- Exact conversation restoration recalls prior context, including a
  multi-round implementation/Review/fix scenario.
- Continuation uses the existing conversation directly when its tab is open;
  closing that tab causes a new tab to resume the exact saved conversation.
- Agent stage output includes the correct native session reference and keeps
  that reference across continuation and terminal replacement.
- Issue completion closes its remaining Runner-created tabs and cleans up
  disposable logs and Worktrees without affecting other Issues or the Runner
  terminal.
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
