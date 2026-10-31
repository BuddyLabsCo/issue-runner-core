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
rewriting children. Standalone documentation runs independently of business-Issue
selection; see [standalone documentation](#standalone-documentation).

A value-less `--issue` reads exactly the configured nonempty `issueList`,
independently of parent discovery. It does not read a parent or expand the list
with children, blockers, or other unselected Issues. List and parent selection
share blocker, label, and Reservation eligibility checks, selecting ascending
Issue numbers up to `maxBatchSize`. Selected Issues run concurrently through
the standalone implementation/Review/fix and publication workflow with their own Worktrees, conversations,
and recovery evidence. A numbered `--issue <number>` selects only that Issue,
regardless of the configured list. For example:

```yaml
issueList: [60, 51, 57]
maxBatchSize: 2
```

```sh
issue-runner run --project my-project --env herdr --issue
```

If all three Issues are eligible, this selects 51 and 57. Ineligible Issues do
not consume Batch slots. A list whose Issues are all closed (`completed` or
`not_planned`) returns `no_work` with exit zero; remaining open work reports
`incomplete` with nonzero exit, including when none is eligible. Local
implementation completion, including `no_change`, earns no delivery credit.
A list succeeds when every selected open Issue is confirmed delivered and no open work remains outside its Batch.
Invalid or empty lists fail at startup.
An unreadable Issue or incomplete blocker read uses ordinary operation
retry/pause handling before any Reservations; it cannot silently become no-work.

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
concurrently through implementation, Review/fixes, publication, and required checks, as a numbered Issue does.
Integration waits for every Batch PR to become CI-ready, then runs serially.
Terminal members with no PR satisfy the Batch barrier; unfinished members still
block integration of their ready siblings.
After a successful Batch, Core rescans parent state, all child pages, blockers,
and ownership before selecting the next Batch. Newly eligible children can run
in that same Run. An unfinished Batch with open children retains its membership
and reports `incomplete`; Core does not replace its members with other work.

Open children prevent parent closure even when they are blocked, externally
owned, unready, reserved, or excluded by `issueList`. Once all children are
terminal, Core rescans before closing the parent as completed. All-cancelled
children also permit closure. An initially empty parent remains `no_work`
without closure. A previously nonempty scope can close after its children leave.
Parent cancellation stops subsequent dispatch and retries without changing
children. A completed parent with open children fails rather than dispatching
work or rewriting tracker state.

Parent closure uses the ordinary operation retry/pause policy and confirms
`closed/completed` from the Tracker. A lost response reconciles current state
before retrying the write. A successful request without confirmed closure
cannot report success. Closure failure retains completed child checkpoints;
a matching rerun continues without repeating their Agent work or merges.
If a delivered child reopens, Core retains its evidence and reports incomplete
instead of using stale delivery credit or repeating completed work.

`maxBatchSize` also bounds concurrency: a Batch of two can run two Issues at
once, and completion order may differ from ascending selection order. No
replacement work starts when one Issue finishes. Core fetches the Target Branch
once for the Batch's fresh Worktrees and uses that exact SHA for each initial
branch. Each Issue keeps its own Worktree, branch, native identity, Probe and
handoff paths, temporary Git configuration, and implementation checkpoint.
Closing one Issue's tab or removing its temporary Git configuration does not
close or alter another Issue's resources.

Before Reservation writes, Core saves Batch membership and ownership at
`recovery/<input-hash>-batch.json`. Per-Issue progress remains at
`recovery/<input-hash>-<issue-number>.json`. Matching reruns retain the recorded
unfinished Batch, including members that are now ineligible or have left parent scope;
Core revalidates each member and reports why it cannot continue rather than
filling its slot from newly eligible work. Cancellation before the first Issue
checkpoint still retains this membership. Invalid Batch ownership or membership
fails recovery before dispatch. Changed arguments or configuration select a new
Batch without adopting previous Reservations. Successful parent Batches mark
their checkpoint complete before further discovery. The next Batch replaces
that membership while preserving each child's execution and delivery evidence.

Non-Agent Operator Pauses are serialized so concurrent failures cannot read the
same terminal input together. Pending pauses gate new workflow operations and
Agent tab operations until the operator retries; already-running native
conversations remain interactive. Cancellation or a fatal Issue error interrupts
active operator input and stops sibling dispatch and automatic follow-ups;
unfinished work and checkpoints remain available for recovery.

Issue-scoped operation failures offer `s` to skip that Issue and retain its
Reservation, Worktree, and handoff evidence. Other Batch members can continue.
Run-level failures, including shared Target Branch discovery/fetch, do not offer
Issue skip. Audit recovery never offers skip or acceptance of a logging gap.

Reservations remain best effort: the configured label is added before the
runner assignee, with full eligibility and ownership revalidation inside every
write attempt, including retries after failed requests or backoff. Core
revalidates parent state, direct-child membership, Issue eligibility, blockers,
and Reservation markers between writes and immediately before substantive Agent
submission, after startup/Probe waits. The same dispatch check gates recovery
continuations and automatic correction prompts after their waits. Parent
cancellation stops subsequent work. A child leaving scope, becoming terminal, blocked or
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
earns delivery credit only after confirmed integration and completed tracker state.
Tab close uses ordinary operation retries/delays and Operator Pause after
exhaustion. A close retry targets the same owned handle without repeating the
accepted implementation or discarding its persisted completion.
Verified `no_change` also gets no delivery credit and skips publication.
Verified commits proceed to publication after enabled Review/fixes.

### Independent Review and required fixes

When Review is enabled (the default), only a verified `committed` implementation
starts it. A separate reviewer starts in a fresh Runner Tab in the original
Worktree with its own per-call Git configuration. Core waits 10 seconds, Probes
only the reviewer's native identity, and saves that role reference before the
Review assignment. Review receives Standards/Spec requirements, the Project
review prompt, Issue context, Worktree, branch, Review base, implementation HEAD,
and an assigned absolute findings path outside the Worktree.

Review accepts exactly `outcome`, `summary`, `commits`, and `findings_file`.
Only `passed` and `findings` are allowed, with a nonempty summary and empty commits.
`passed` requires null findings. `findings` requires the exact assigned absolute
path and a regular nonempty report there. Independent Git inspection rejects
reviewer commits, dirty files, changed branch/base, and rewritten implementation
history. Review is instructed to write only its report and handoff, without
implementation edits or remote operations.

After accepted findings, Core saves the Review result and closes its tab before
opening a fresh tab that resumes the exact original implementation conversation.
After the 10-second wait, the fix receives the findings report, reviewed HEAD as
its Base SHA, and a fresh handoff path. It must produce verified new commits and
a clean Worktree. `no_change` cannot satisfy findings. Core verifies both this
turn's commits relative to the reviewed HEAD and the complete accumulated history
relative to the initial base. The original implementation result and each round's
verified fix commits remain recorded separately; their ordered combination is
the implementation eligible for publication. Initial Probe PR metadata remains
fixed throughout.

Later Reviews resume the exact original reviewer in fresh tabs, with a
10-second wait and fresh invocation/path. The previous reviewed HEAD becomes the
next Review base; the implementation HEAD includes the latest fixes.
`workflow.maxReviewRounds` has no default cap. With a cap, every allowed findings
round still receives its fix before the loop exits. For example:

```yaml
workflow:
  review: true
  maxReviewRounds: 1
```

This allows implementation -> Review findings -> verified fix -> publication
eligibility, with no second Review. Validation corrections stay in their current
stage tab, use fresh handoff paths and the ordinary correction budget, and do not
spend another Review round or startup wait. Setting `workflow.review: false`
skips Review and fixes. Initial `no_change` also skips Review.

Snapshots preserve both role references, each round's base/HEAD/findings,
invocations, pending prompts, budgets, accepted Review/fix results, and phase at
transitions. Matching in-flight Review/fix recovery processes existing results
before opening a tab; absent attempted output resumes the saved role and sends
only `continue`. Original uncommitted fix work is retained. Invalid or missing
role/round/ownership context fails visibly. Stop leftover native sessions before
recovery as described below.

Findings are retained during unfinished, failed, and cancelled loops, then removed
after the complete Review/fix loop, including final-round fixes. Probe/handoff
files and their temporary/superseded files remain until successful Issue cleanup.
Per-call Git configuration is removed after every stage. Findings cleanup uses
ordinary operation handling and can be retried from the completed checkpoint.
Verified local eligibility proceeds to publication below. Only merged work with
confirmed tracker completion can receive successful-delivery credit.

### Publication and CI-ready retention

Runner owns pushes, PR creation, integration, and tracker writes. Agents only inspect, edit, check, and commit locally. Before pushing, Runner revalidates eligibility and verifies the original Worktree, delivery branch, base, cleanliness, and accumulated implementation/fix commits. It pushes the exact verified HEAD without force and creates a non-draft PR with the accepted Probe title and body. Probe metadata remains fixed even when fixes change the final implementation.

Publication intent is saved before pushing or attempting PR creation. Checkpoints record the branch, Target Branch, intended HEAD, fixed metadata, verified commits, PR number/URL, discovery deadline, check deadline, and observed checks.

A lost push response is reconciled against the intended remote HEAD. A lost PR response is reconciled against all PR pages using the exact branch, Target Branch, and HEAD. Multiple matches, conflicting identity, closed/draft PRs, or unexpected remote advancement enter ordinary non-Agent Operator Pause; Runner never force-pushes or creates a replacement automatically.

With matching Run inputs, recovery uses the saved publication intent and original Probe metadata. An absent remote branch can receive the verified push only while that push remains pending. An exact remote HEAD confirms the push without repeating it. A missing branch after a confirmed push requires Operator Pause. Recovery creates an absent PR without a pause only when no creation was attempted; an uncertain creation follows the authorization rule below.

An uncertain creation with no exact match requires explicit operator authorization before another creation attempt. Audit retries repeat only the audit action.

Recovery can adopt an exact merged PR and skip required-check discovery. If the Issue also became closed/completed while Runner was stopped, Runner confirms the recorded PR identity and merged HEAD before completing delivery and cleanup. The merged branch may already be deleted; a surviving branch must still match the recorded HEAD. Tracker completion alone grants no delivery credit. Conflicting evidence retains the execution resources without another push, PR, or Agent assignment.

Runner waits 30 seconds before required-check discovery. Empty checks or checks with no pending, failed, or cancelled entries establish readiness, preserving the source treatment of skipped checks. Pending checks are polled every 10 seconds, bounded by `timeouts.requiredChecksMinutes`. A timeout enters Operator Pause; Enter starts another configured wait window and q/EOF cancels.

Failed or cancelled required checks start CI repair using `agents.ciRepair`. Each attempt uses a fresh native conversation and a separate repair Worktree and local branch based on the recorded PR head. Its assignment includes the Issue, PR URL, failed check names/states/links, Git context, and original fixed PR metadata. The original PR and remote branch remain unchanged in identity. Repair Probes establish only native session identity; they never regenerate publication metadata. Each start or exact resume waits 10 seconds, and each completed stage closes its own Runner Tab.

Runner verifies the repair Worktree, local branch, base, cleanliness, actual changes, and exact commit claims before pushing the verified HEAD to the original remote branch. It never force-pushes. Lost push responses reconcile against persisted pending-push evidence; unexpected remote advancement or PR identity changes require ordinary operation recovery. Each repair push restarts the 30-second discovery delay and required-check timeout window. CI repair does not enter ordinary Review.

The CI budget allows two consumed attempts per generation, independently of operation retries, handoff corrections, and conflict repair. A valid `no_change` or failed Git verification consumes an attempt without a push. Invalid handoff schemas stay in the same stage under the ordinary correction/manual-output policy; `blocked` is invalid. After two consumed attempts, Runner pauses. Enter authorizes another check observation after 30 seconds. Passing checks need no further repair; continued failure starts a new two-attempt generation. `q` or EOF cancels, and Issue-scoped pauses also support skip.

Snapshots retain each attempt's identity, generation, native session, repair Worktree/branch/base, Probe/handoff assignments, correction counts, result, verification failure, consumed count, and pending or confirmed push. Recovery verifies retained evidence without restarting implementation or Review. Existing repair output is processed before opening a tab; missing attempted output resumes the exact repair session and sends only `continue`. Exhausted budgets remain exhausted across restart. Unmerged and failed resources, including repair Worktrees, remain available for inspection. Eligibility changes stop the affected Issue, and cancellation prevents new repair, publication, or check operations.

With a numbered `--issue` or `--document`, the CLI accepts `--no-auto-merge`:

```sh
issue-runner run --project my-project --env herdr --issue 50 --no-auto-merge
```

With `--no-auto-merge`, a CI-ready unmerged PR retains its remote branch, original Worktree, Probe/handoff files, Reservation, and recovery evidence. The summary reports the PR URL and retained paths with outcome `incomplete` and nonzero exit. It grants no successful-delivery credit, performs no success cleanup, closes no Issue, and triggers no documentation maintenance.

### Confirmed integration and Issue delivery

Auto-merge defaults on. Runner waits for every PR in the Batch to become CI-ready before integrating any PR. Earlier implementation completion or passing checks cannot bypass this barrier. Once the Batch is ready, Runner integrates serially by ascending PR creation time, then PR number, regardless of Issue selection or implementation completion order.

Runner requests squash integration against the observed HEAD with `codeHost.adminMerge` controlling the admin flag. After CI or conflict repair, it requires the latest verified and pushed repair HEAD while retaining the original publication metadata. A changed HEAD or closed, unmerged PR cannot earn delivery credit. Queue admission only starts the confirmation wait. Runner polls every 10 seconds within `timeouts.mergeQueueMinutes`; a timeout enters Operator Pause. Enter refreshes remote state and starts another configured wait window; q/EOF cancels.

Runner confirms each merge and completed Issue closure before starting the next PR's integration. A later failure stops ordered integration without rolling back earlier confirmed deliveries; their saved merge and closure evidence remains intact. Runner does not update or repush every remaining branch merely because the Target Branch advanced.

Explicit conflict evidence starts repair using `agents.conflictRepair`: either the host reports `conflicting`, or the squash request returns an explicit conflict. Unknown mergeability and generic rejections do not start repair. Other rejections preserve their original cause through ordinary operation retries and Operator Pause.

Each conflict attempt starts a fresh native conversation in a separate repair Worktree and local branch from the latest verified PR head. Runner fetches the current Target Branch SHA and supplies it with the conflict, Issue, PR URL, Git context, and fixed PR metadata. The Agent merges that SHA locally and resolves conflicts. Runner verifies the original-head ancestry, fetched-target ancestry, branch, base, cleanliness, actual changes, and exact commit claims before pushing to the original remote branch. It never force-pushes, recreates the PR, or enters ordinary Review.

A conflict push restarts the normal 30-second check-discovery delay and configured check timeout. Failed checks use the separate CI budget. The conflict budget permits two consumed attempts per generation; `no_change` and failed Git verification consume an attempt without a push. Invalid handoffs use the same stage's correction policy. After exhaustion, Enter authorizes refreshed merge-state observation. Continued explicit conflict starts a new generation; unknown mergeability is polled within `timeouts.mergeQueueMinutes`. A resolved conflict refreshes required checks before integration, without consuming another conflict attempt. `q` or EOF cancels; Issue-scoped pauses also support skip.

Snapshots retain conflict evidence, target SHA, attempt identities, native sessions, Worktrees, results, push evidence, consumed counts, and authorized generations. Recovery processes existing output before opening a tab, or resumes the exact repair conversation with only `continue` when output is absent. It preserves exhaustion, fixed PR metadata, and the original remote identity. Cancellation stops further dispatch and remote operations; unfinished resources remain available for recovery.

For either repair category, interruption during the Session Probe can leave its identity file written before the snapshot records the session. Recovery validates that retained Probe and resumes its exact conversation for the repair assignment. It does not start another repair conversation or regenerate PR metadata. If the Probe is missing or invalid and no native identity was saved, Runner offers whole-Issue restart or exit. Retain the original repair Worktree and native history until recovery completes.

Completed repairs skip Agent work on restart, but Runner rechecks Git evidence before pushing or reconciling a pending push. Only the exact recorded remote HEAD confirms a completed push; unrelated remote changes cannot authorize replacement. CI and conflict consumed counts and generations remain separate across tab replacement and Runner restart. Authorizing another CI generation leaves the conflict budget unchanged, and vice versa.

After confirmed integration, `ticketClosure: runner` closes the Issue as completed and confirms its state from the tracker. A lost response is reconciled before repeating a merge or closure write. A successful write response alone does not establish delivery.

With `ticketClosure: code_host`, Runner leaves closure to the host. It waits 10 seconds before observing tracker state, then another 30 seconds if the Issue remains open. If it is still open, Operator Pause allows another observation cycle. Runner does not write tracker closure under this policy.

Delivery requires confirmed integration and tracker `closed/completed`. Reservation release, an unmerged PR, and `not_planned` closure earn no delivery credit. The checkpoint saves merge confirmation, completed closure, and the exact case-sensitive labels observed at confirmed delivery. Matching recovery skips completed Agent/merge work and preserves those delivery-time labels for downstream documentation maintenance.

Successful numbered Issues and fully delivered Issue Lists return `succeeded` with exit zero after cleanup and any triggered maintenance succeed. Parent Runs continue through subsequent Batches and confirm parent closure when all children are terminal.

### Successful Issue cleanup

After confirmed delivery, Runner closes residual owned Runner Tabs and removes that execution's Worktrees and local branches. Cleanup verifies each Worktree's ownership and expected branch HEAD before removal. Ownership changes or rejected operations retain unfinished resources and use ordinary retries and Operator Pause.

Cleanup removes assigned Session Probe and handoff JSON files, their `.tmp` siblings, and superseded corrections across implementation, Review, fixes, and repairs. A completed stage alone never deletes these files. Failed, cancelled, interrupted, skipped, unfinished, and `--no-auto-merge` executions retain them. Native conversation histories, other Issues' files and tabs, and the operator's Runner terminal remain outside cleanup.

Atomic execution checkpoints record each completed Worktree/branch removal and each final or temporary file deletion separately. Matching recovery retries only unfinished actions, without repeating Agent work, merge, or tracker closure. Audit records retain operation attempts and failures. If interruption prevents saving an action's completion, cleanup rechecks current Git state and tolerates already absent files. Keep native sessions stopped before recovery; Runner does not look up old tab handles.

A rejected or unresolved targeted close remains incomplete cleanup. A resolved close completes Runner's termination responsibility; Runner does not wait for processes, descendants, or external writers. Per-call Git configuration cleanup and Review-loop findings cleanup keep their existing timing. Workflow audits and Recovery Snapshots remain available after successful cleanup.

### Automatic documentation after a Batch

Set `workflow.docMaintainTriggerLabel` to enable documentation after successful delivery:

```yaml
workflow:
  docMaintainTriggerLabel: Docs
```

Runner compares this trimmed setting exactly and case-sensitively with labels captured at confirmed successful delivery. `Docs` matches `Docs`, but not `docs`, `Docs-extra`, or ` Docs `. Later label edits do not change the saved delivery evidence. Empty or omitted settings disable automatic maintenance.

One matching successful Batch creates one maintenance occurrence, even when several delivered Issues match. Numbered Issues and Issue Lists use the same trigger. Cancelled Issues, ordinary implementation `no_change`, and unmerged work earn no delivery credit. A partially delivered Batch must finish before maintenance starts.

Automatic maintenance uses the [document workflow](#standalone-documentation), including its configuration requirements, normal publication and repair paths, and independently verified no-change completion. It fetches the current Target Branch after business delivery and runs without ordinary Review. Pending or unsuccessful maintenance blocks subsequent Batch discovery and parent closure; it retains its owned artifacts for recovery.

The Batch checkpoint records its maintenance association before document work starts. The occurrence has its own `recovery/<input-hash>-document-batch-<occurrence>.json` checkpoint and Maintenance Ticket execution. Matching inputs resume that occurrence before parent discovery, even when all business children are already closed. Completed maintenance satisfies its original barrier without creating another occurrence. Changed arguments or configuration start a new Run without adopting the old occurrence or deleting its artifacts.

Recovery also checks that the occurrence belongs to the Batch's saved Run, including when maintenance is already completed. A mismatched occurrence cannot satisfy the discovery or closure barrier. An explicit restart creates a new Maintenance Ticket and document execution while keeping the original Batch association. If that replacement is interrupted, matching recovery continues it before business discovery.

### Standalone documentation

Run documentation maintenance without selecting a business Issue:

```sh
issue-runner run --project demo --env herdr --document
```

Supply `agents.documentation`, a nonempty `prompts/documentation.md`, and the
`maintenanceTicket.title`, `body`, and `label` settings. The delivery trigger label
is optional for `--document`; no delivery or matching business-Issue label is required.
The current startup rules still require the implementation profile and prompt.

Runner ensures the maintenance label exists and creates an ordinary, unassigned
Maintenance Ticket. It uses a separate documentation execution, Worktree, Session
Probe, native conversation, fixed PR metadata, and handoff assignments. It does not
read a parent, select from `issueList`, reserve a business Issue, or run ordinary Review.
New assignees, missing maintenance markers, Reservation markers, or open blockers
stop advancement and retain the occurrence's resources.

Committed documentation uses the normal Git verification, publication, required-check,
CI/conflict repair, integration, and tracker-closure paths. `--no-auto-merge` retains
the CI-ready PR and its working resources, reports `incomplete`, and leaves the ticket open.
Runner independently verifies a `no_change` result against the assigned branch and
base, a clean Worktree, no commits, and no actual changes. It closes and confirms the
Maintenance Ticket as `closed/completed` without pushing or creating a PR, including
under `ticketClosure: code_host` or `--no-auto-merge`.

Recovery stores the maintenance occurrence in `recovery/<input-hash>-document.json`
and its execution in `recovery/<input-hash>-document-<ticket>.json`. Matching interrupted
Runs reuse the original ticket, native conversation, paths, PR metadata, and consumed
budgets. Completed document stages skip Agent work. Existing output is verified before
opening a tab; missing output resumes the saved documentation conversation, waits
10 seconds, and sends only `continue`. Exhausted corrections remain exhausted;
superseded handoffs cannot replace the current assignment. Close leftover Agent
tabs and stop their execution before recovery, retaining native history and Worktrees.
Runner does not adopt live tabs. If the original context cannot be recovered, Runner
prints `unable to recover` and offers an entire documentation-occurrence restart or exit.
Restart retains the old resources and starts at documentation with a new ticket and execution.

Recovery preserves uncommitted work in the original Worktree. Each Agent call recreates temporary Git configuration from the matching Run configuration and removes it afterward. Old temporary configuration files are not recovery inputs.

Changed arguments or configuration start a separate occurrence and retain the old
one. After a completed Run, the next `--document` invocation starts a new occurrence.
An uncertain ticket-creation response stops automatic creation; inspect remote state
before explicitly authorizing another creation. Runner never adopts an unrelated
old Maintenance Ticket by its title or label.

After confirmed delivery or verified no-change closure, Runner removes the owned
Worktree/local branch and Probe/handoff files. It verifies ownership and branch HEAD
before removal and retains resources if ownership changed. Cleanup can resume after
partial completion. Failed, cancelled, unfinished, skipped, and unmerged work retains
its resources; native histories and unrelated tabs remain untouched.

### Cancellation and explicit reruns

Press Ctrl+C to cancel Runner, or enter `q`/EOF at a non-Agent Operator Pause.
Cancellation interrupts startup waits, polling, and retry delays, including waits
in sibling Batch executions. Runner stops subsequent dispatch, terminal input,
and resource creation, reports `cancelled`, and exits nonzero.
Input already queued in a terminal can still execute; cancellation does not undo
that input or establish that Agent processes have stopped.

Runner retains unfinished Worktrees, Probe/handoff files, and Recovery Snapshots.
Snapshots preserve accepted stage completion and consumed retry counts, including
corrections allocated before a cancelled delay. Cancellation never automatically
restarts an Issue or grants another correction budget. To continue, stop leftover
Agent sessions and explicitly rerun with the same arguments and `config.yaml`.
Recovery uses the saved progress where the original context remains available.

### Retained execution resources

Failed, cancelled, skipped, interrupted, and CI-ready unmerged executions retain their original working context. This includes owned Worktrees and recorded branches, uncommitted changes, Probe/handoff files and their temporary or superseded files, and necessary Review findings. Failed and replaced repair attempts retain their own resources alongside the original execution. Findings are removed after the complete Review/fix loop as described above.

At Run exit, `Retained` reports identify executions, recorded branches, and resource paths that still exist. Reports cover only executions created or restored by that Run, including documentation and repairs. Recovery Snapshots preserve fixed PR metadata, native role references, assigned paths, accepted results, and consumed budgets. Maintenance checkpoints and archived occurrences remain available. If Runner terminates abruptly, a final report may be absent; inspect the Project's `recovery/` snapshots and original resource paths.

Changed arguments or configuration ignore old progress without authorizing its deletion or adopting an unrelated Reservation. Runner adds no retention expiry, periodic pruning, or native-history deletion. Per-call temporary Git configuration is removed when each call unwinds, including failure and cancellation; abrupt process termination can prevent that cleanup. Later stages recreate their temporary configuration.

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

Matching reruns restore a pending correction's deadline before sending it.
Time while Runner is stopped counts toward the delay; only the remaining time
is waited. The allocated correction keeps its invocation, path, and consumed
count. An existing final file is validated before sending any follow-up.

After exhaustion (immediately when `agentRetry: 0`), Core displays diagnostics,
the native session identity, and the current path. It keeps the stage and tab
available and stops automatic correction prompts. Fix the reported problem in
that native conversation, including the actual Git state when needed, then
explicitly invoke `issue-runner-handoff` with the displayed path to replace its
file. Further invalid writes leave the budget exhausted; a later valid write is
independently verified and can complete the stage. Restarting with matching
inputs retains the consumed budget, exhausted status, and active path. Runner
displays the manual-correction instructions again before any continuation.
A missing final file resumes the saved conversation with only `continue`;
this spends no correction and keeps the manual path. Superseded results remain
ineligible even when valid.

Run startup displays `sessionid=n/a` for workflow work without an Agent conversation.
Each Agent stage identifies its Issue and purpose, with `sessionid=pending` before its Probe.
After the Probe, progress shows the actual native identity and absolute active handoff path.
Corrections update that path; resumed work displays its saved identity and assignment.

The final report lists Issues in selection order, even when concurrent work finishes in another order.
Documentation appears as maintenance work after its triggering Batch.
Each structured CLI result includes `exitCode`, `logPath`, and a `summary` with the Run outcome and reasons.
For a started Run, `summary.tickets` contains ordered records with Issue number, kind, status, PR number/URL, detail, and retained Worktrees.
Failures and cancellation retain these records and resource details already observed by Runner.
An abrupt termination can prevent a final report.

`completed` requires confirmed merge and completed tracker state.
Documentation can also finish as `no_change` after verified closure.
An ordinary Issue's `no_change` handoff leaves delivery incomplete.
`PR ready` identifies CI-ready unmerged work; it grants no delivery credit.
A handoff or Reservation release alone never proves successful delivery.
`succeeded`/`no_work` exit zero. `incomplete`/`cancelled`/`failed` exit nonzero.

Workflow observations and outcomes have JSONL audits under the Project's
`logs/`. Audit records redact configured tracker and code-host credentials in string values before JSON serialization.
They record workflow operations and diagnostics, without Agent output or conversation transcripts.
Cancellation stops audit retries; the final outcome event may be absent when the cancellation signal is already set.
Implementation snapshots under
`recovery/` record execution/Run identities, role references, Probe metadata,
invocation/path, a known unsent assignment or correction prompt, correction count,
result facts and stage completion. Execution, Batch, and maintenance snapshots
store `run_arguments` and `input_hash` in their existing atomic checkpoints.
The SHA-256 hash combines the exact Run argument array with the raw `config.yaml`
bytes read and validated at startup. Argument order and configuration comments
therefore affect matching. Each checkpoint validates its input scope and workflow
ownership before restoring native invocation progress. Handles are process-local
and never persisted. Audit logs are diagnostic output, never recovery input;
unfinished `.tmp` snapshots cannot replace the last valid checkpoint.

Matching arguments and configuration select saved progress for that Project and
mode. Without matching progress, Runner starts a new Run with fresh counts.
Changing either arguments alone or configuration alone ignores the old snapshots;
Runner neither forces old settings nor enters recovery-failure pause for that
mismatch. Copied or invalid checkpoints at the matching path fail ownership
validation before dispatch.

In-flight assigned implementation
can resume its exact saved native conversation in the original Worktree; no
replacement assignment is sent. An existing expected result is verified before
opening a terminal; valid retained output can complete without a native tab.
Invalid retained output opens the original conversation only for an automatic
correction that needs submission; exhausted output can be corrected manually at
its current path. When eligibility revalidation withholds an assignment or
correction, its exact prompt remains pending in the checkpoint. Once eligible,
Core resumes the original native conversation and submits that prompt with the
same invocation/path and fixed PR metadata. A withheld correction keeps its
already consumed budget and superseded paths; recovery does not spend another
retry. Cancellation during the dispatch gate also retains known unsent work.

Core processes a valid expected result before sending a pending prompt. Once a
dispatch attempt begins, the checkpoint no longer classifies the prompt as known
unsent; a rejected eligibility check restores that evidence. If an attempted
assignment has no expected result, recovery sends only `continue` after the resume
wait. Runner opens a fresh Runner Tab in the original Worktree, recreates its
per-call Git configuration, submits the exact saved role's resume command with
Enter, waits 10 seconds, then submits the literal `continue` with that Agent's
configured `submitKey`. It sends no task, path reminder, context message, or new
Probe. The invocation, active output path, fixed PR metadata, and consumed
correction count remain unchanged, including an exhausted correction budget.
Staged, unstaged, and untracked work remain in the original Worktree.
Checkpoints without pending-prompt evidence retain this continuation-only
behavior. Uncertain transport and abrupt process loss around dispatch retain
the existing continuation-only recovery behavior.

Recovery checks only the active invocation's assigned final path. Files at
superseded paths, unrelated files, and `.tmp` siblings cannot complete that stage.
Implementation, Review, fixes, repairs, and documentation retain their normal
purpose-specific validation and independent Git checks during recovery:

| Saved stage and observed output | Recovery behavior |
| --- | --- |
| Unfinished stage, valid expected final | Verify and persist completion before advancing; no Agent tab is needed for that stage. |
| Unfinished stage, invalid expected final | Keep the stage incomplete and use its remaining correction budget, or wait for manual correction when exhausted. |
| Unfinished stage, only a superseded final or active `.tmp` | Treat the expected final as absent; retain the active invocation and path. |
| Crash after validation but before completion persistence | Re-read the expected final and repeat normal verification. |
| Crash after completion persistence | Skip the completed Agent stage and continue the next recorded workflow step, rechecking required Git evidence. |

Recovery preserves fixed PR metadata and original working resources, including
staged edits and untracked files. Restart alone never creates a replacement
assignment or regenerates metadata. Completed stages use saved result facts even
if their handoff files later change or disappear; changed Git evidence can still
prevent advancement. Runner never reopens or closes an old opaque tab handle.
Earlier incomplete startup snapshots fail visibly and remain retained.

Review recovery keeps the original implementation and reviewer conversations
separate. A missing Review handoff resumes the reviewer; a missing fix handoff
resumes the implementation conversation. Both use the original Worktree, fixed
PR metadata, and active invocation. Recovery retains the round, Review base/HEAD,
assigned findings, accumulated commits, and consumed correction budget.

Completed Reviews and fixes use their saved results without repeating Agent work.
A findings Review still requires a committed fix, including the final allowed
round. Restarting cannot add a Review round or let `no_change` satisfy findings.
Keep the assigned findings report until fixes finish; Runner removes Review
reports after the Review/fix workflow completes. A missing or empty required
report offers the recovery-failure choice below. Restarting that Issue leaves
other Issues' progress intact.

If required original context cannot be restored, Runner prints exactly
`unable to recover`. This includes missing original Worktrees, missing native role
references, rejected native resume submissions, and invalid execution, Review/fix,
or repair checkpoints. Runner offers exactly two choices:

- Enter restarts the entire affected Issue from implementation.
- `q` exits Runner. EOF also cancels.

There is no retry-recovery or skip choice at this prompt. Cancellation creates no
replacement execution. Runner does not inspect Agent screens or infer history
availability from terminal activity; successful command submission cannot prove
that the native CLI restored its history.

An explicit restart creates a new execution, branch, Worktree, conversations,
Probe/handoff assignments, and Probe-generated PR metadata. Execution correction
and repair counts start fresh. Other Issues keep their progress and counts.
Runner archives the failed checkpoint as `<checkpoint>.<id>.retained` before
starting replacement work. It keeps the active failed checkpoint until replacement
progress is saved, so matching reruns can recover after cancellation during startup.
Old Worktrees, branches, handoff files, and native histories remain under the
failed-resource retention policy. Existing remote PRs
still require normal publication ownership checks; restart does not authorize
overwriting them. Standalone documentation restarts at its document entry point
through its existing whole-occurrence interaction.

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
- `maxBatchSize` is a positive safe integer that bounds both Batch membership
  and concurrent Issue execution. `targetBranch`, when supplied, is
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
  Operator Pause: Enter retries, q/EOF cancels; Issue-scoped failures also allow
  `s` to skip that Issue. Audit failures retry only the
  log action, never the completed external operation.
- `ticketClosure` is `runner` or `code_host`. Neither authorizes closing the
  empty parent.

All configuration, credential, prompt, selection, and plugin validation occurs
before delivery side effects. Help/version/init need neither credentials nor
a plugin. Cancellation prevents new reads and retry follow-ups.

## Non-Agent recovery

Automatic retries apply only to operations that can safely repeat. Each retry
cycle allows the initial attempt plus `operationRetry` additional attempts.
`operationRetryDelay` uses seconds and repeats its final delay when needed.
Enter authorizes another cycle after exhaustion; unsupported input does not
authorize any action. Manual retries do not consume the automatic budget.

Within a saved Issue or documentation execution, failed operations retain their
consumed attempts, last error, and retry deadline in the Recovery Snapshot.
Runner saves each automatic retry before starting it; cancellation inside that
operation still consumes the attempt.
Matching reruns wait only the remaining delay and use only the remaining
attempts for that operation and target. Exhausted operations return to Operator
Pause before another attempt, including after cancellation with `q`.
Successful operations clear their retry state. Snapshot-write failures retain
the existing checkpoint retry policy; an unavailable snapshot cannot save its
own failed writes.

| Operation | Recovery policy |
| --- | --- |
| API/Git observations, Target Branch fetch, local checkpoints | Bounded automatic retries, then Operator Pause |
| Reservation label/assignee writes | Revalidate current eligibility and ownership before each attempt; confirm state immediately after failure before retrying |
| Worktree or Runner Tab creation | Pause after the first failure; only Enter authorizes another resource-creation attempt |
| Command, Probe, task, correction, or continuation transport | Report failure without replaying input, redirecting its target, or opening an uncertain-delivery interaction |
| Owned tab close | Retry the same handle automatically, then pause; retain accepted stage completion and report rejected/unresolved cleanup |
| Audit creation or append | Pause and retry only the same log action; never replay a completed business effect |

Creation failures may leave partial resources or resources whose identifiers were
not returned. Inspect those resources before authorizing another attempt.
Reservation reconciliation avoids repeating an already observed mutation even
when `operationRetry` is zero. Changed eligibility still prevents later writes
and Agent dispatch.

API and Git commands have 60-second I/O bounds. Core also bounds each terminal
plugin call to 60 seconds and stops waiting immediately on Run cancellation.
Timing out cannot cancel the underlying plugin operation or prove that it had no
effect. A rejected or unresolved close remains incomplete cleanup; Core neither
waits for process settlement nor redirects the close to another tab.
Successful input transport ends the I/O bound. Native approvals, questions, and
missing Probe/result files remain in the native conversation or handoff watcher;
they do not become non-Agent Operator Pauses.

Audit records identify the operation, target, attempt, and failure without logging
prompt bodies or serializing tab handles. Audit recovery gates new operations
until the log action succeeds. Enter retries logging; `q`/EOF cancels. Neither `s`
nor claimed success can bypass logging. Completed Reservation writes, resource
creation, prompt transport, and close operations are not replayed because their
result append failed.

## Verification limits

Run the composed five-Issue scenarios without Herdr or Agent credentials:

```sh
node --test tests/run/full-contract.test.ts tests/run/full-contract-failure.test.ts
```

The scenarios use `maxBatchSize: 3`, enabled Review, and `docMaintainTriggerLabel: Docs`. The first and fourth Issues carry `Docs`; the fifth depends on all four earlier Issues. This produces Batches of three, one, and one, with committed documentation maintenance between Batches. Scripted external dependencies and a private fake terminal drive `executeCli` through the real conversation coordinator and correlated temporary files.

The success case holds the first Batch's CI barrier while implementations finish out of order. It checks original-role Review/fix resumption, ordered integration and closure, maintenance barriers, snapshots, owned cleanup, reports, and exit status. Failure cases cover Reservation retries, manual correction after automatic exhaustion, and cancellation followed by matching-input recovery with only `continue` for the missing handoff. Independent CI/conflict repair budgets and incompatible failure combinations remain in focused tests. These checks do not establish live Agent acceptance, native history restoration, or Herdr transport behavior.

Private scripted tests enter through `executeCli` with real temporary config,
prompts, and audit files. An empty Run never needs a conversation coordinator;
the fake terminal records forbidden terminal operations. Tests cover
startup rejection, conditional purposes, scope ordering, no-work, pagination,
operation retries, cancellation, and audit failures. Package tests install built
artifacts into an isolated custom global prefix and run from a separate Launch
Directory. Complete implementation Runs exercise the real conversation/handoff
coordinator over a private fake terminal, real Probe/result/snapshot files, and
scripted boundary dependencies. Review Runs cover independent role identity,
Standards/Spec context, exact original-role resume, uncapped and final-round fixes,
strict findings validation, correction budgets, and retained Review/fix progress.
Publication Runs cover fixed metadata, exact PR identity, lost push/create responses,
remote advancement, 30-second discovery, pending/passing/failed checks, timeouts,
retention, cancellation, and the GitHub adapter through scripted command I/O.
CI-repair Runs cover fresh conversations and Worktrees, failed-check context,
fixed metadata, independent consumed-attempt budgets, operator generations,
recovery, pending-push reconciliation, cancellation, and rejected checkpoint
ownership. Real Git repairs verify separate local branches, pushes to the original
remote branch, and rejection of empty repair commits. Conflict-repair Runs cover
explicit evidence, queued conflicts, independent budgets and authorized generations,
conflict-to-CI handoff, recovery, and lost push responses. Real Git conflict repairs
merge an advanced target and reject repairs missing its ancestry.
Integration Runs control implementation completion and check readiness for parent and Issue List Batches, verify creation-time/PR-number ordering and serial merge confirmation, and retain exact partial delivery checkpoints after a later rejection or conflict. They also cover queued merge confirmation,
closure policies and observation waits, lost responses, changed HEAD rejection,
delivery-time labels, and recovery without replaying confirmed operations.
Focused real Git Runs verify fresh bases,
Worktrees, clean state, actual commits, rejection of empty commits, reviewer edits,
and fixes relative to the reviewed HEAD with cumulative commit evidence.
Parent Runs cover paginated children/blockers, numeric Batch selection, Issue
List and label semantics, mixed ownership, retained partial writes, lost-response
reconciliation, revalidation changes, cancellation, and recorded execution
continuation through the real Core coordinator and a private fake terminal.
Standalone Issue List Runs cover exact scope, ordering, eligibility, terminal
and incomplete outcomes, startup rejection, numbered-Issue precedence,
cancellation, and matching versus changed-input recovery at the same boundary.
Both selectors cover bounded concurrency with explicitly reversed completion,
isolated contexts and targeted closes, retained Batch membership, and sibling
cancellation. Real Git checks run concurrent Issues from a freshly advanced
Target Branch with separate per-call Git configurations.
Controlled Runs also cover seconds-based backoff/final-delay reuse, immediate
lost-response reconciliation with zero retries, Issue skip, manual creation
recovery, terminal I/O bounds/cancellation, and audit failures after completed
mutations and transport. They use real audit-file failures and controlled timers;
no Herdr installation, Agent account, or model call is required.
No public testing entry, filesystem port, or scheduler is added.

Run `npm run test:package` to check built Core and private fake-plugin tarballs
installed together in a custom npm global prefix. A separate Launch Directory
exercises npm's installed executable, init templates, bundled purpose prompts,
public JavaScript/types, and the exact manually installable handoff asset.
See [package verification](terminal-contract.md#verification-limits-and-global-installation)
for setup and evidence limits.

Installed-package cases also relocate the global prefix and invoke Core through
a link. They exercise public import selection, asynchronous initialization,
malformed modules/factories/methods, and isolation from Project packages, other
prefixes, PATH, NODE_PATH, npm caches, and linked entries outside the package.

These checks do not prove live Herdr delivery, native Agent restoration, full
delivery workflows, or macOS operation. Those remain downstream verification.
