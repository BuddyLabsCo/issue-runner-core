# Runner interruption and native session recovery

Investigated on 2026-10-29 (Asia/Shanghai).

## Source revision

The production baseline is
`BuddyLabsCo/sandcastle-runner@0adf499bf69217b56256ca2affb1c0dca0894110`.
The local research checkout is
`ae78d525770df81d6e35e92908327c537c72616c`; `git diff` confirms there are no
changes under `src/` or `tests/` between those revisions. All source links below
are pinned to the production baseline.

## Findings

### Restart recovery deliberately excludes native conversations

The specification explicitly says that Agent session state is in memory for
the current Run, that the audit log is diagnostic rather than recovery input,
and that implementation/Review session reuse is limited to one Runner process.
Cross-process conversation restoration is excluded.

Sources:
[scope](https://github.com/BuddyLabsCo/sandcastle-runner/blob/0adf499bf69217b56256ca2affb1c0dca0894110/docs/specs/v1-orchestration.md#L7-L15),
[review lifecycle](https://github.com/BuddyLabsCo/sandcastle-runner/blob/0adf499bf69217b56256ca2affb1c0dca0894110/docs/specs/v1-orchestration.md#L125-L127),
[recovery boundary](https://github.com/BuddyLabsCo/sandcastle-runner/blob/0adf499bf69217b56256ca2affb1c0dca0894110/docs/specs/v1-orchestration.md#L165-L168),
[explicit exclusion](https://github.com/BuddyLabsCo/sandcastle-runner/blob/0adf499bf69217b56256ca2affb1c0dca0894110/docs/specs/v1-orchestration.md#L221).

Implementation agrees: `SandcastleAgentExecutor` owns an in-memory
`Map<logFile, nativeSessionId>`. Each CLI invocation creates a new executor.
The Recovery Snapshot has no dedicated Agent-conversation persistence or
restoration contract. Diagnostic evidence may contain session IDs, but restart
does not hydrate the executor's session map from it.

Sources:
[executor state](https://github.com/BuddyLabsCo/sandcastle-runner/blob/0adf499bf69217b56256ca2affb1c0dca0894110/src/adapters/sandcastle.ts#L127-L143),
[executor creation](https://github.com/BuddyLabsCo/sandcastle-runner/blob/0adf499bf69217b56256ca2affb1c0dca0894110/src/cli.ts#L690-L691),
[snapshot contract](https://github.com/BuddyLabsCo/sandcastle-runner/blob/0adf499bf69217b56256ca2affb1c0dca0894110/src/recovery.ts#L162-L190).

### Existing recovery is more than a persisted step number

Re-running the same delivery scope reads its canonical Recovery Snapshot and
validates its identity. The snapshot records batches, completed deliveries,
maintenance state, cleanup records, publication intent and evidence, PR
identity, and independent CI/conflict repair budgets and Worktree/head facts.
Writes use a synced temporary file followed by rename.

Sources:
[snapshot loading](https://github.com/BuddyLabsCo/sandcastle-runner/blob/0adf499bf69217b56256ca2affb1c0dca0894110/src/cli.ts#L590-L619),
[publication and repair fields](https://github.com/BuddyLabsCo/sandcastle-runner/blob/0adf499bf69217b56256ca2affb1c0dca0894110/src/recovery.ts#L33-L77),
[snapshot fields](https://github.com/BuddyLabsCo/sandcastle-runner/blob/0adf499bf69217b56256ca2affb1c0dca0894110/src/recovery.ts#L162-L190),
[atomic persistence](https://github.com/BuddyLabsCo/sandcastle-runner/blob/0adf499bf69217b56256ca2affb1c0dca0894110/src/recovery.ts#L542-L566).

Restart reconciles exact remote evidence. Matching remote branch heads and PR
identity can be adopted without rerunning implementation; an unexpected head
pauses rather than being overwritten. An absent remote branch for a
`pending_push` intent restarts implementation. A separate `--document` Run
does not read or write the delivery Recovery Snapshot.

Sources:
[publication recovery](https://github.com/BuddyLabsCo/sandcastle-runner/blob/0adf499bf69217b56256ca2affb1c0dca0894110/src/run/pull-request-recovery.ts#L166-L230),
[delivery-only persistence](https://github.com/BuddyLabsCo/sandcastle-runner/blob/0adf499bf69217b56256ca2affb1c0dca0894110/src/cli.ts#L594-L607).

### Worktrees are not unconditionally recreated

For an unfinished implementation without adopted publication evidence, the
recovered active batch is routed back through `implementBatch`. Each new CLI
invocation has a fresh `runId`; `implementTicket` creates a new branch and
Worktree containing that ID, and begins with an empty implementation session
object. Thus this path does not continue the old coding conversation or
reuse its old Worktree.

Sources:
[fresh Run ID](https://github.com/BuddyLabsCo/sandcastle-runner/blob/0adf499bf69217b56256ca2affb1c0dca0894110/src/cli.ts#L590),
[batch restart routing](https://github.com/BuddyLabsCo/sandcastle-runner/blob/0adf499bf69217b56256ca2affb1c0dca0894110/src/run/run.ts#L959-L1005),
[Worktree and session creation](https://github.com/BuddyLabsCo/sandcastle-runner/blob/0adf499bf69217b56256ca2affb1c0dca0894110/src/run/attempt.ts#L49-L82).

However, adopted publication work proceeds without rerunning implementation.
Recorded repair state can retain its original Worktree/branch identity, and
terminal cleanup can remove recorded Worktrees belonging to a previous Run.
Consequently, "every restart recreates all Worktrees" is inaccurate.

Sources:
[adopted publication test](https://github.com/BuddyLabsCo/sandcastle-runner/blob/0adf499bf69217b56256ca2affb1c0dca0894110/tests/run/cli-restart-parent.test.ts#L25-L98),
[retained repair identity](https://github.com/BuddyLabsCo/sandcastle-runner/blob/0adf499bf69217b56256ca2affb1c0dca0894110/src/run/pull-request-repair.ts#L53-L71),
[cleanup after restart test](https://github.com/BuddyLabsCo/sandcastle-runner/blob/0adf499bf69217b56256ca2affb1c0dca0894110/tests/run/cleanup.test.ts#L91-L135).

### Same-process continuation already exists

The original Runner probes a native session, saves its ID in the executor map,
and passes `resumeSession` for substantive calls. Review keeps separate
implementation and reviewer session objects, sending findings back to the
implementation conversation and subsequent reviews back to the reviewer.

Sources:
[session probe](https://github.com/BuddyLabsCo/sandcastle-runner/blob/0adf499bf69217b56256ca2affb1c0dca0894110/src/adapters/sandcastle.ts#L223-L287),
[native resume invocation](https://github.com/BuddyLabsCo/sandcastle-runner/blob/0adf499bf69217b56256ca2affb1c0dca0894110/src/adapters/sandcastle.ts#L419-L439),
[review/fix loop](https://github.com/BuddyLabsCo/sandcastle-runner/blob/0adf499bf69217b56256ca2affb1c0dca0894110/src/run/review-attempt.ts#L340-L413),
[review reuse test](https://github.com/BuddyLabsCo/sandcastle-runner/blob/0adf499bf69217b56256ca2affb1c0dca0894110/tests/run/cli-review-rounds.test.ts#L20-L185).

A continuation without a usable native session fails explicitly. Automatic
recovery does not silently substitute a fresh conversation. Operator Pause
can allow a fresh attempt where no usable session exists; this is distinct
from exact-session continuation.

Sources:
[unavailable-session check](https://github.com/BuddyLabsCo/sandcastle-runner/blob/0adf499bf69217b56256ca2affb1c0dca0894110/src/adapters/sandcastle.ts#L382-L393),
[manual handling policy](https://github.com/BuddyLabsCo/sandcastle-runner/blob/0adf499bf69217b56256ca2affb1c0dca0894110/docs/specs/v1-orchestration.md#L114-L127).

### Abrupt interruption and operator cancellation differ

The domain definition distinguishes operating-system termination from Run
cancellation. Entering `q` or EOF at Operator Pause cancels the Run after
owned-process settlement; the concurrent-attempt test checks that the other
attempt is aborted and settled. Ordinary attempt unwinding also deletes its
temporary Git configuration. These guarantees cannot simply be assumed after
an abrupt process kill: management of an old process is expressly excluded
from restart recovery.

Sources:
[Run cancellation definition](https://github.com/BuddyLabsCo/sandcastle-runner/blob/0adf499bf69217b56256ca2affb1c0dca0894110/CONTEXT.md#L83-L85),
[operator cancellation](https://github.com/BuddyLabsCo/sandcastle-runner/blob/0adf499bf69217b56256ca2affb1c0dca0894110/docs/specs/v1-orchestration.md#L167-L173),
[settlement test](https://github.com/BuddyLabsCo/sandcastle-runner/blob/0adf499bf69217b56256ca2affb1c0dca0894110/tests/run/cli-cancellation.test.ts#L77-L134),
[temporary configuration lifetime](https://github.com/BuddyLabsCo/sandcastle-runner/blob/0adf499bf69217b56256ca2affb1c0dca0894110/src/run/agent-operation.ts#L235-L298).

## Feasibility for issue-runner-core

Persisting native conversation identity across Runner restarts is feasible.
It intentionally expands the original Runner's recovery boundary rather than
merely replacing Sandcastle transport. The current design already calls for
persisting the association between `session_ref`, Run, role, Worktree, terminal,
and configuration, but does not yet specify the complete restart algorithm.

Sources: [current design](../design.md#session-probe-file-handoff),
[open recovery details](../design.md#open-execution-details),
and the original explicit exclusion cited above.

### Primary-source capability checks

- Claude Code documents resuming a specific session by ID or transcript path
  with `--resume`. Disabling native session persistence prevents later resume.
  This establishes an example of the required CLI capability, not universal
  compatibility for every configured Agent.
  Source: [official CLI reference](https://code.claude.com/docs/en/cli-reference).
- Herdr documents that normal detach leaves server-owned processes running.
  A full server restart restores layout but does not preserve those processes.
  Eligible integrated Agent panes may resume automatically; unsupported or
  unusable references can restore as shells. Runner must reconcile what is
  actually present before launching its own replacement.
  Source: [official session lifecycle](https://herdr.dev/docs/session-state/).
- Herdr exposes tab/pane list and get operations, process information, and a
  session snapshot. Event history is not durable: reconnect requires fresh
  authoritative reads. Process information is platform-dependent and is not
  a universal proof of native conversation identity or descendant settlement.
  Source: [official socket API](https://herdr.dev/docs/socket-api/).

These official pages were read on 2026-10-29. Installed-version compatibility
still requires testing; no Herdr binary or Agent CLI was invoked in this pass.

### Proposed durable state

Extend the Recovery Snapshot or an associated versioned record with:

| State | Purpose |
| --- | --- |
| Issue, logical conversation role, native `session_ref` | Restore the original implementation and Review conversations independently |
| Original Worktree, branch/base evidence, relevant review HEAD and findings path | Continue the same working copy and review/fix loop, including uncommitted work |
| Selected environment, server/workspace identity, owned terminal locator | Reconcile a surviving terminal without following current UI focus or trusting a reused ID |
| Resolved start/resume profile, model/options, storage root, required environment and config-file references | Reopen the intended conversation in its original execution context |
| Invocation identity, assigned prompt/probe/result paths, dispatch/acceptance state, existing retry budgets | Detect completed handoffs and avoid duplicate work or retry-budget resets |

Persist task assignment before sending its prompt and persist the native
reference before substantive work. Keep durable state, required configuration,
handoff files, and native session storage available while the Issue remains
recoverable. Normal Issue-completion cleanup can still close its tabs and
remove its disposable logs and Worktree. An interrupted Run must not trigger
that completion cleanup.

### Proposed restart sequence

1. Load the exact recovery record and validate ownership, configuration
   compatibility, and the original Worktree. Retain the original working copy
   rather than unconditionally creating a new one.
2. Inspect assigned final result files first. Validate and reconcile any result
   published while Runner was down, preserving once-only workflow acceptance.
   If it was already accepted, continue downstream rather than dispatch again.
3. Query the selected Herdr environment afresh. If the original conversation
   still exists in its owned tab, reattach Runner's observation and wait for its
   pending result. Do not start a second Agent or blindly resend the task.
4. If no live original conversation remains and a continuation is required,
   establish any required process settlement, create an appropriate terminal,
   resume the exact persisted native reference in the original Worktree and
   configuration, then submit the required continuation after readiness.
5. Persist replacement terminal associations and continue the existing
   workflow, result validation, independent Git checks, and retry policy.

This sequence is a design recommendation inferred from the documented
capabilities and existing file-handoff contract, not implemented behavior.
It also applies after Herdr server restart, but must account for any session
Herdr has already restored and must not assume a restored tab hosts an Agent.

### Limits that a saved session ID does not solve

- Conversation context can resume; an interrupted tool call, shell job, or
  external side effect is not thereby restored or rolled back.
- A crash between prompt submission and recording its acknowledgement leaves
  uncertain delivery. Terminal queue admission alone does not prove an Agent
  consumed the prompt. The generic terminal contract cannot promise exactly-once
  prompt execution; uncertain dispatch needs reconciliation, not blind replay.
- Missing native history, a missing Worktree, incompatible configuration, or an
  unresolved old writer must produce an explicit recovery failure under the
  agreed policy, not a silent fresh-conversation substitute.
- Standalone `--document` currently has no delivery Recovery Snapshot. Including
  it in the new durable-session promise requires persistence for that Run type
  too; it does not inherit recovery automatically.

Acceptance should cover Runner-only restart with surviving Agent tabs; tab
closure followed by exact resume; full Herdr restart; a completed result during
Runner downtime; a crash around result acceptance or uncertain prompt
submission; and the implementation/Review/fix loop with both native identities
preserved.

## Validation and limits

Ran the following existing tests against the local checkout, whose runtime
and test files match the production baseline:

```text
node --test --test-timeout=60000 tests/run/cli-restart-parent.test.ts tests/run/cli-review-rounds.test.ts tests/adapters/sandcastle-native-recovery.test.ts tests/recovery.test.ts
24 passed; 0 failed.
```

These are local tests using controlled dependencies. No live Agent, Herdr
session, abrupt operating-system termination, or real GitHub writes were
exercised. The proposed durable native conversation recovery is supported by
documented capabilities, but is not an existing capability established by
these tests. This investigation adds a research note only; it does not amend
the agreed design or implement recovery.
