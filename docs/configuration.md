# Configuration and startup

This slice extracts startup from `BuddyLabsCo/sandcastle-runner` revision
`0adf499bf69217b56256ca2affb1c0dca0894110`. Source `main` was rechecked on
October 30, 2026 and still names that revision. The local source checkout at
`ae78d525770df81d6e35e92908327c537c72616c` has identical runtime, tests, and
package manifests. Core uses the source CLI/application entry pattern and
Tracker, CodeHost, GitWorkspace, Clock, and OperatorIO boundaries. It does not
import source Sandcastle/provider execution or transcript/session-pause code.

## Installation and Project selection

Use Node.js 22.18 or later within 22.x and npm 11.x. Build with `npm ci` and
`npm run build`; `npm pack` also builds. Install Core and the selected terminal
plugin globally in the same active npm installation environment/prefix,
including a custom prefix. The artifact includes CLI code, terminal JS/types,
init templates, and the handoff skill for manual installation.

```sh
npm install -g /path/to/core.tgz /path/to/plugin.tgz
issue-runner --help
issue-runner --version
issue-runner init --project my-project
issue-runner run --project my-project --env herdr --parent 42
```

The Launch Directory is the operator's working directory. Project keys use
letters, digits, dot, underscore, or hyphen and identify exactly one child:
`<launch-directory>/<project>/config.yaml`. Dot, dot-dot, paths, and ancestor
lookup are rejected. Global package installation does not relocate this config.
`init` creates that child, `config.yaml`, and `prompts/implement.md`,
`prompts/review.md`, and `prompts/documentation.md`. It refuses an existing
destination, including a file or symbolic link, and retains partial output if
copying fails. Edit its placeholders before running.

`--env <name>` accepts lowercase letters, digits, and separating hyphens.
Core loads only `issue-runner-<name>` through its public import entry, beside the
executing Core package. It checks contract version 1, the zero-argument factory,
initialization, and all three methods before workflow reads or mutations.
Project-local packages, other global prefixes, and caches cannot substitute for
a missing sibling. No automatic installation or backend fallback occurs.

Lookup follows the executing Core package's real location, including after
relocating a portable installation or invoking Core through a link. It does not
ask the `npm` on PATH to choose a prefix. A sibling link into another prefix
or a package cache is rejected, as is a public entry that escapes the selected
package. Nested Core dependencies cannot substitute for the selected sibling.
The package's public `import` entry is used; private entries and unrelated
plugins are not initialized.

Startup errors name `issue-runner-<name>`, retain the underlying import or
initialization error, and explain the required contract-v1/same-prefix
installation. For a missing package, install the selected plugin into the
prefix containing the Core executable you actually invoked. For a version,
export, factory, or method error, use a compatible plugin in that same prefix.
An incompatible sibling is never replaced with a Project-local or cached copy.
These failures happen before audit creation, Reservations, Worktrees, or Agent
dispatch.

## Run scope

Option ordering is independent. Exactly one selector is required:

| Selector | Meaning |
| --- | --- |
| `--parent <number>` | Direct children of one parent; configured `issueList` limits selection |
| `--issue <number>` | One standalone Issue |
| `--issue` | Standalone Issue List from nonempty `issueList` |
| `--document` | Standalone Documentation Maintenance |

Numbers must be positive safe integers. `issueList` must contain unique positive
safe integers and is sorted numerically. `--auto-merge` and `--no-auto-merge`
are mutually exclusive, accept no values, and require a numbered `--issue` or
`--document`. Auto-merge defaults on. Unknown options are rejected.

Parent Runs resolve
`targetBranch` from config or the CodeHost default, inspect parent state, read
all child pages, and return `no_work` without closing an initially empty open
parent. A configured Issue List does not make an empty parent nonempty; missing
numbers appear in the summary. Cancelled parents return `cancelled` without
rewriting children. Standalone Issue Lists and documentation remain
unimplemented and report `incomplete` without delivery mutations.

For a nonempty open parent, Core reads every direct child's native blocker pages
before selecting work, including terminal children, children outside the
configured Issue List, and children with external ownership or Reservations.
Blockers outside the parent, including other repositories, participate.
Both `completed` and `not_planned` closed blockers unblock work; open blockers
prevent selection. Unsupported terminal reasons, incomplete reads, and invalid
pagination prevent selection. Cross-repository direct children are unsupported.

Eligible children are open, carry the exact case-sensitive `ready-for-agent`
label, have no assignee other than the configured runner, and have no open
blockers. Other labels do not change eligibility. A nonempty `issueList`
restricts selection to matching direct children; it never expands parent scope.
Core selects ascending Issue numbers up to `maxBatchSize`, reports selected
numbers and blocked/owned/reserved/missing work, and dispatches that Batch
sequentially through the same implementation checkpoint as a numbered Issue.
Review, concurrent execution, publication, and further delivery Batches remain
downstream; local completion leaves the parent Run `incomplete`.

Reservations remain best effort: the configured label is added before the
runner assignee, with current state checked before retrying a write. Core
revalidates parent state, direct-child membership, Issue eligibility, blockers,
and Reservation markers between writes and before dispatch. Parent cancellation
stops subsequent work. A child leaving scope, becoming terminal, blocked or
externally owned, or losing required labels/markers stops its continuation.
Partial writes and other residual markers are retained without automatic
compensation. These checks do not provide a lock or an atomic claim.

A complete Reservation (label and runner assignee) can continue only with a
matching input-hash checkpoint that validates the recorded execution ownership.
Unrelated complete Reservations and partial Reservations (only one marker)
are reported and skipped, without consuming a Batch slot. Changed arguments
or configuration never adopt earlier Reservations. Matching completed
implementations are verified without redispatch; matching in-flight work uses
the existing native conversation/handoff recovery path.

A numbered `--issue` also supports the implementation checkpoint. The Issue
must be open, have `ready-for-agent`, have no open blockers (including blockers
on later pages), and have no external assignee or unrelated/partial Reservation.
Core adds the configured Reservation label and runner assignee, revalidates
eligibility/ownership, fetches the Target Branch, and creates an isolated
Worktree and branch from that exact base. Partial writes remain retained.
The Reservation label must already exist in the repository.

Core opens a tab with an absolute cwd and a unique temporary `GIT_CONFIG_GLOBAL`
overlay. It submits the full configured start command with Enter, waits 10
seconds, then separately submits a correlated Session Probe with the Agent
chord. Probe identity, Issue/project/repository/role ownership, and complete
PR title/body are validated and saved atomically. The Agent reads the target
repository's PR conventions when producing this metadata. Metadata remains fixed
for the execution. A fresh invocation and absolute handoff path are persisted
before task submission, without another startup delay. The built-in instructions
and Project implementation prompt explicitly invoke the installed handoff skill.
The temporary Git configuration is removed when the call finishes.

Invalid Probe output uses `operationRetry` and `operationRetryDelay`, separately
from execution-result corrections. Each Probe retry saves its consumed count and
a fresh correlation/path before submission; missing output never spends this
budget or causes reminders. After exhaustion, the active Probe path remains
available for manual publication in the native conversation.
All generated Probe IDs remain recorded for the execution and are rejected as
native identity, including IDs from superseded Probe assignments.

Only the exact four-field execution schema is accepted, after independent
Worktree, branch, base, clean-state and full commit/message checks. A `committed`
result must also contain real changes relative to the base. Accepted facts and
stage completion are saved before targeted tab closure. A local implementation
is not delivered: the Run reports `incomplete` until later workflow steps exist.
Tab close uses ordinary operation retries/delays and Operator Pause after
exhaustion. A close retry targets the same owned handle without repeating the
accepted implementation or discarding its persisted completion.
Verified `no_change` also gets no delivery credit. Neither auto-merge flag
changes this checkpoint's behavior.

### Rejected handoffs and manual correction

Invalid JSON, wrong fields or outcomes, invalid execution findings, and false
Git claims leave the implementation incomplete. Core sends the validation error
and a fresh absolute handoff path to the current tab and native conversation,
using the configured Agent chord without another startup wait. Each correction's
unique invocation/path, superseded path, and consumed count are saved before its
delay and prompt. Superseded files cannot satisfy the active assignment.

Core reads only the active assigned final path immediately and every 250 ms
while the stage is incomplete. It does not depend on filesystem notifications.
Temporary siblings and other invocation paths cannot satisfy the assignment.
Unique suffixes keep assignment paths distinct even when timestamps coincide.
An incomplete final file can be overwritten in place or replaced by atomic
rename. Change detection includes the contents read, so matching file metadata
cannot hide changed output; republishing identical output after correcting Git
state also permits another verification.

The exact read that passes schema and independent verification supplies the
saved result, even if the file is replaced during verification. Once accepted,
Core stops observing that path. Later overwrites cause no further stage
transition or validation, and Core makes no immutable accepted-file copy.

`agentRetry` counts additional automatic corrections after the initial result.
For example, `agentRetry: 3` with `agentRetryDelay: [2, 5]` allows three
corrections, after 2, 5, and 5 seconds. This budget is independent of
`operationRetry`, Probe retries, and CI/conflict repair budgets. Cancellation
during a delay prevents submission and retains the consumed count. Missing
output, including a temporary sibling without its final file, spends no
correction budget and causes no automatic prompt.

After exhaustion (immediately when `agentRetry: 0`), Core displays diagnostics,
the native session identity, and the current path. It keeps the stage and tab
available and stops automatic correction prompts. Fix the reported problem in
that native conversation, including the actual Git state when needed, then
explicitly invoke `issue-runner-handoff` with the displayed path to replace its
file. Further invalid writes leave the budget exhausted; a later valid write is
independently verified and can complete the stage. Restarting with matching
inputs retains the consumed budget and active path.

`succeeded`/`no_work` exit zero. `incomplete`/`cancelled`/`failed` exit nonzero.
Workflow observations and outcomes have JSONL audits under the Project's
`logs/`. There are no Agent transcripts. Implementation snapshots under
`recovery/` record execution/Run identities, role references, Probe metadata,
invocation/path, correction count, result facts and stage completion. Handles
are process-local and never persisted. A hash of Run arguments and raw
`config.yaml` scopes matching progress. In-flight assigned implementation
can resume its exact saved native conversation in the original Worktree; no
replacement assignment is sent. An existing expected result is verified before
opening a terminal; valid retained output can complete without a native tab.
Invalid retained output opens the original conversation only for an automatic
correction that needs submission; exhausted output can be corrected manually at
its current path. An absent expected result receives only
`continue` after the resume wait. Completed stages are verified without
redispatch. Earlier incomplete startup snapshots fail visibly and remain
retained; broader recovery/restart policy belongs to downstream slices.

Before recovery, manually close leftover Agent tabs and stop their sessions
while retaining native histories and original resources. Core neither enforces
this premise nor adopts surviving handles. Mismatched inputs ignore old progress
and do not adopt its Reservation. Unfinished and locally completed checkpoint
files/Worktrees are retained; only per-call Git configuration is removed.

## Configuration rules

Use [the init template](../templates/config.yaml) as the complete example.
Unknown or obsolete fields are rejected at every Runner-owned object.

- `repository` is `owner/repo`; `checkout` is an absolute path.
- `tracker.tokenEnv` and `codeHost.tokenEnv` name nonempty inherited credential
  values. Credentials are not written into audit records. `runnerAccount` and
  `reservationLabel` are required. `codeHost.adminMerge` is a required boolean.
- `maxBatchSize` is a positive safe integer. `targetBranch`, when supplied, is
  nonempty; omission selects the repository default.
- Each Agent purpose has complete nonempty `start` and `resume` shell-command
  strings. `resume` must contain exactly spelled `{sessionref}` at least once.
  Authors supply shell quoting and all native flags. Core does not choose a
  brand, reconstruct argv, translate options, or edit keymaps.
- Optional `submitKey` is a nonempty Runner setting beside `start`/`resume`,
  outside the optional opaque native `options` object. Omission uses Enter.
  Old `agent`, `model`, and `reasoningEffort` profile fields are rejected.
- `implement`, `ciRepair`, and `conflictRepair` profiles are required. Review
  defaults enabled, requiring its profile and nonempty `prompts/review.md`.
  Setting `workflow.review: false` removes that requirement. An optional
  `maxReviewRounds` is a positive safe integer with no default cap.
- The trimmed `workflow.docMaintainTriggerLabel` is case-sensitive;
  omitted/empty/whitespace disables automatic maintenance. A nonempty trigger
  or `--document` requires the documentation profile, nonempty documentation
  prompt, and `maintenanceTicket.title`, `body`, and `label`. The implementation
  prompt is always required and nonempty. Supplied optional profiles are still
  validated when their feature is disabled.
- All timeouts are positive finite minutes. `agentIdleMinutes` defaults to 10;
  `agentMinutes`, `requiredChecksMinutes`, and `mergeQueueMinutes` are required.
  They do not authorize automated missing-output reminders or Agent-session Pause.
- `operationRetry` and `agentRetry` are nonnegative safe integers counting
  additional attempts. Both delay schedules are nonempty positive finite
  seconds; the last delay repeats. Exhausted operation reads retain non-Agent
  Operator Pause: Enter retries, q/EOF cancels. Audit failures retry only the
  log action, never the completed external operation.
- `ticketClosure` is `runner` or `code_host`. Neither authorizes closing the
  empty parent.

All configuration, credential, prompt, selection, and plugin validation occurs
before delivery side effects. Help/version/init need neither credentials nor
a plugin. Cancellation prevents new reads and retry follow-ups.

## Verification limits

Private scripted tests enter through `executeCli` with real temporary config,
prompts, and audit files. An empty Run never needs a conversation coordinator;
the fake terminal records forbidden terminal operations. Tests cover
startup rejection, conditional purposes, scope ordering, no-work, pagination,
operation retries, cancellation, and audit failures. Package tests install built
artifacts into an isolated custom global prefix and run from a separate Launch
Directory. Complete implementation Runs exercise the real conversation/handoff
coordinator over a private fake terminal, real Probe/result/snapshot files, and
scripted boundary dependencies. Focused real Git Runs verify fresh bases,
Worktrees, clean state, actual commits, and rejection of empty commits.
Parent Runs cover paginated children/blockers, numeric Batch selection, Issue
List and label semantics, mixed ownership, retained partial writes, lost-response
reconciliation, revalidation changes, cancellation, and recorded execution
continuation through the real Core coordinator and a private fake terminal.
No public testing entry, filesystem port, or scheduler is added.

Installed-package cases also relocate the global prefix and invoke Core through
a link. They exercise public import selection, asynchronous initialization,
malformed modules/factories/methods, and isolation from Project packages, other
prefixes, PATH, NODE_PATH, npm caches, and linked entries outside the package.

These checks do not prove live Herdr delivery, native Agent restoration, full
delivery workflows, or macOS operation. Those remain downstream verification.
