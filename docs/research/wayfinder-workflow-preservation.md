# Source workflow preservation and extraction inventory

Investigated on 2026-10-29 (Asia/Shanghai) for
[Inventory source workflow behavior and migration boundaries][ticket], under
[Plan interactive Issue Runner delivery with Herdr][map].

This is evidence for planning, not an implementation spec or a resolution of
the human lifecycle, handoff, recovery, packaging, or Herdr decisions.

## Revision and evidence boundary

- `git ls-remote origin refs/heads/main` in the source repository returned
  `0adf499bf69217b56256ca2affb1c0dca0894110` during this investigation. This is
  both the recorded design baseline and the observed current source `main`.
- The available local source checkout is
  `ae78d525770df81d6e35e92908327c537c72616c`. Its `src/` and `tests/` have no
  differences from that baseline. Findings below are pinned to the baseline,
  rather than assuming the local branch is the released/main revision.
- The [source orchestration specification][spec], actual runtime, and focused
  tests are complementary evidence. The spec alone is not an implementation or
  live-compatibility guarantee. Concrete wording differences matter:
  [the provider adapter][provider] includes the explicit CodeBuddy path in
  addition to dynamically resolving Sandcastle exports, and
  [freshRepairHandoff][fresh-repair] creates fresh repair Worktrees from the
  stable remote branch while retaining the original PR/remote identity.
  The spec also says a schema-valid blocked repair consumes a repair attempt,
  but the runtime pauses before returning that result and
  [the CI repair test][blocked-repair-test] explicitly asserts that blocked
  repair does not consume the budget. This is an unresolved spec/runtime
  discrepancy, not permission for the research to choose a new policy.
  Generic spec descriptions of the supported examples and repairing the
  "original branch" must not erase these actual behaviors.
- Recheck source `main` and inventory any later runtime/test changes when
  extraction begins. There is no later `main` runtime revision to reconcile
  in the observed snapshot.

The committed [starting design][design] is the proposal. The map's Notes also
record later requirements: removal of Runner transcript capture, per-Issue tab
closure, live-tab reuse versus exact native resume, session IDs in progress,
and a requested durable-conversation extension. The last extension still
needs its recovery policy settled.

## Preservation inventory

| Area | Existing invariant to carry into Core | Source and reusable test seam |
| --- | --- | --- |
| CLI and Project startup | One selected Project; exactly one of parent scope, standalone issue scope/list, or standalone documentation. Validate config, prompts, credentials and Agent profile envelope before workflow effects. Keep target-branch resolution, strict fields, positive budgets/timeouts/batch size, and conditional Review/documentation configuration. Start/resume command configuration replaces the execution-specific profile shape; it does not authorize relaxing unrelated validation. | [spec startup][spec-startup], `src/cli.ts`, `src/config.ts`, `src/project-directory.ts`, `src/init.ts`; [startup tests][startup-tests], `tests/run/config-yaml.test.ts`, `config-retry.test.ts`, `example-project.test.ts`, `cli-issue-list.test.ts` |
| Discovery and ownership | Read all same-repository direct-child and blocker pages; reject unsupported cross-repository scope. Respect external assignees and partial/complete Reservations, native blockers outside the parent, ascending issue order, and configured batch size. Closed `completed` and `not_planned` blockers both unblock. Reservations remain best effort, not a lock or atomic multi-host exclusion. | [spec discovery][spec-discovery], `src/run/discovery.ts`, `discovery-state.ts`, `standalone-discovery.ts`; [eligibility tests][eligibility-tests], `cli-config-reservation.test.ts`, `cli-parent-errors.test.ts` |
| Boundaries and rescans | Revalidate parent/issue/blockers at operation boundaries. Parent cancellation stops without rewriting children; contradictory completed parent fails. Rescan after each Batch and before final closure. No children initially means `no_work`, not parent closure; unresolved children mean `incomplete`; all closed children permit closure, including all cancelled children. | [spec discovery][spec-discovery], `src/run/run.ts`, `standalone-run.ts`; `cli-rescan-integration.test.ts`, `cli-paused-boundary.test.ts`, `cli-parent-close-reconciliation.test.ts`, `cli-restart-parent.test.ts` |
| Worktrees and parallel execution | Fresh initial branches/Worktrees from a freshly fetched target commit; separate concurrent issues. Preserve configured bounded concurrency and the persisted recovered Batch size. Keep real local Git inspection, absolute working paths and ownership-bound cleanup. | [initial attempt][attempt], [Git adapter][git-workspace], `src/run/run-batch.ts`; `cli-attempt-batch.test.ts`, [Git tests][git-tests], `worktree-lifecycle.test.ts` |
| Agent responsibilities | Agents modify/check/commit locally; Runner owns pushes, PRs, integration and tracker mutations. Retain purpose-specific prompts and existing common business result schemas. The no-sandbox execution model makes this an instruction/ownership contract, not a hard security sandbox. | [spec execution][spec-execution], [attempt orchestration][agent-operation], [prompts][prompts], [schemas][schemas]; `sandcastle-prompts.test.ts`, `sandcastle-results.test.ts`, `cli-reservation-publication.test.ts` |
| Review and fixes | Review starts only after verified committed initial implementation, on its working copy. Review Standards and Spec, read issue/repository instructions, write findings to the assigned Markdown path, avoid implementation edits/commits. Fix in the original implementation conversation; re-review in the original Review conversation using the previous reviewed HEAD as the next review base. Preserve initial PR metadata and accumulate verified fix commits. | [Review orchestration][review], [spec Review][spec-review]; [review tests][review-tests], [round tests][round-tests] |
| Publication and CI | Push verified work, retain AI-authored PR metadata, create non-draft PRs. Keep required-check discovery delay, required-check semantics, wait timeout, bounded CI repair, and verification before repair push. Runner does not add review/ruleset checks or proactively update every branch because the target advanced. | [spec publication][spec-publication], `src/run/pull-request.ts`, `pull-request-core.ts`, `pull-request-repair.ts`; `cli-publication-failures.test.ts`, `cli-ci-repair.test.ts`, `cli-git-observation-recovery.test.ts` |
| Integration and repair | Every PR in a Batch must be CI-ready before serial squash integration, ordered by `createdAt` then PR number. Match observed head on merge; preserve optional admin policy. Explicit conflict starts conflict repair; other merge rejection preserves the original error. Queued merge requires confirmed merge. Do not roll back earlier integrations. | [spec publication][spec-publication], `src/run/pull-request.ts`, `pull-request-repair.ts`; `cli-merge.test.ts`, `cli-conflict-budget.test.ts`, `cli-conflict-closure.test.ts`, `cli-cancellation.test.ts` |
| Completion | A merged PR and confirmed `closed/completed` ticket are both required. Preserve `runner` versus `code_host` closure policy, completion evidence and delivery-time labels. Reservation release or `not_planned` is not successful delivery. | [spec closure][spec-closure], `src/run/pull-request-core.ts`; `cli-closure-repair.test.ts`, `cli-parent-close-reconciliation.test.ts`, `cli-rescan-integration.test.ts` |
| Documentation Maintenance | Exact, case-sensitive trigger label from confirmed delivery evidence; one occurrence per successful matching Batch. It is an inter-Batch barrier. A new Maintenance Ticket uses documentation execution and ordinary publication/CI/conflict/closure. Verified no-change closes without a PR. Changed trigger config stops old automatic continuation while retaining/reporting artifacts. | [spec maintenance][spec-maintenance], `src/run/maintenance.ts`, `src/run/run.ts`; `cli-maintenance.test.ts`, `cli-maintenance-skip.test.ts`, `cli-document-maintenance.test.ts`, `cli-config-reservation.test.ts` |
| Cleanup and retained resources | Preserve bounded ownership checks, partial cleanup evidence and retry of remaining work. Retain unfinished/cancelled evidence under existing policy. `--no-auto-merge` retains CI-ready unmerged artifacts. New tab closure extends resource cleanup and must wait for the required writer/process guarantees. | [cleanup implementation][cleanup], [cleanup coordination][cleanup-coordination]; `cleanup.test.ts`, `worktree-lifecycle.test.ts`, `worktree-repair-lifecycle.test.ts`, `cli-no-auto-merge-cleanup.test.ts` |
| Audit, report and outcomes | Keep diagnostic JSONL operation start/result/error records, sanitized diagnostics, retry of audit operations without replaying completed business actions, ordered issue summaries, retained-resource reports and exit codes. `succeeded`/`no_work` exit zero; `incomplete`/`cancelled`/`failed` do not. Transcript removal does not remove workflow audit or Recovery Snapshots. | [spec audit][spec-audit], `src/audit.ts`, `src/run/operation-audit.ts`, `report.ts`; `cli-report*.test.ts`, `cli-report-failures.test.ts`, [operation tests][operation-tests] |

### Agent purposes and conversation identity

| Purpose | Existing input/result and continuation requirements |
| --- | --- |
| Session probe | Select the same purpose-specific native profile and obtain a real native session before substantive execution. Probe retries use Operation Retry. The old `SESSION_READY` string and Sandcastle stream extraction are transport details, replaced by the proposed Session Probe file contract. |
| Initial implementation | Task/Worktree/branch/base context plus Project implementation prompt; common result and required PR metadata. A verified committed result may enter Review; `no_change` is not delivery. |
| Review | Strict `REVIEW_INPUT` with Worktree, delivery branch, issue reference, review base, implementation HEAD and assigned findings path. Strict result is only `passed`, `findings` with exact assigned path, or `blocked` with explanation. The findings file must exist, be a regular nonempty file, and survive until needed fixes finish. |
| Review fix | Assigned findings path and reviewed HEAD; continue the original implementation conversation, retain PR metadata, validate each fix against actual Git state. `no_change` cannot silently satisfy requested fixes. |
| Later review rounds | Continue the same reviewer and review only the next diff, allowing surrounding-code reads and checks of fixes/new findings. Optional `maxReviewRounds` has no default cap; even the last allowed findings round receives a fix before delivery proceeds without another review. Retry/correction is not a new review round. |
| CI repair | Fresh Agent Attempt and repair Worktree where the real adapter provides remote identity; failing required-check names/states/links, common result, existing PR metadata. Independently verify and publish to the original stable remote branch/PR. |
| Conflict repair | Fresh attempt/repair Worktree, current target/base and conflict evidence, common result, existing PR. Verify ancestry/Git evidence before Runner pushes; subsequent CI uses the independent CI budget. |
| Documentation | Documentation profile/prompt and Maintenance Ticket context. PR metadata required only for a committed result. No-change is independently verified and closes the Maintenance Ticket without PR. No ordinary Review loop follows it. |
| Execution/output continuation | Reuse the current native conversation for bounded failure recovery or JSON re-emission. An unusable exact session is not automatically substituted with a new conversation. |

Sources: [attempt entry points][attempt], [Review loop][review],
[native execution][executor], [schemas][schemas], [repair context][fresh-repair],
and [source execution/Review rules][spec-review]. No Review follows initial
`no_change`/`blocked`, documentation, CI repair, or conflict repair.

The source already reuses implementation and Review sessions **within one
Runner process**. `AgentSession` retains `logFile`/`resumePrompt`; the executor
stores `Map<logFile, nativeSessionId>` and reply state in memory. Transcript
removal therefore requires a replacement logical conversation key, rather than
deleting session tracking with the logging calls. Native identity, assigned
invocation, and terminal location must remain distinct. Sources:
[session objects][agent-operation], [executor state][executor-state],
[review loop][review], [round tests][round-tests].

## Retry, result and verification rules

| Boundary | Existing bounded behavior | Migration consequence |
| --- | --- | --- |
| External reads and session probes | `operationRetry` is additional retries, with configured seconds and final delay reused. External API/Git calls have a 60-second bound. After budget exhaustion, existing non-Agent external-read handling pauses and Enter resets its budget. | Retain reads and delays; specify how a failed *Agent startup/probe* exits the removed Agent intervention path without discarding the probe budget. |
| Workflow writes | Only opted-in set-like writes receive automatic Operation Retry. State-confirmed writes reconcile before first mutation and after failures. Resource creation does not get automatic replay; other failed local/workflow writes use Operator Pause. | Do not turn a terminal API retry into permission to replay a PR/issue creation, or replay a completed business effect because audit failed. |
| Substantive invocation failure | After confirmed settlement, same usable session, not cancelled, bounded `agentRetry` and `agentRetryDelay`; failure classification is generic rather than provider-text/429/brand parsing. | Keep the budget and exact-session intent; settle a replacement writer before resume. Define exhausted/unusable-session outcomes in the lifecycle decision. |
| Missing output | Continue the same usable session with bounded Agent Retry to request the required result. | Missing result files still need a bounded missing-output policy. Waiting forever is a policy change. |
| Invalid structured output | Disable Sandcastle's own retry loop; Runner owns bounded same-session correction. A recovered final payload must independently validate. | Reuse business schemas and correction semantics with fresh handoff paths; no native screen classifier or operator message substitutes for a valid result. |
| CI and conflict repairs | Independent two-consumed-attempt budgets per ticket, including Maintenance Tickets. In runtime, verified repair and returned `no_change` consume; blocked pauses inside the Agent wrapper without consuming, as explicitly tested for CI. Execution/output/verification failures do not consume. The spec's blocked-consumes wording conflicts with this. Operator authorization can start another two-attempt generation after a fresh observation. | Keep separate persisted budget identities/generations; do not confuse Agent Retry with repair attempts or reset either merely because a tab was replaced. Resolve blocked-result policy explicitly in the lifecycle decision. |
| Cancellation | Once caller cancellation is observed, stop probe retries, execution retries, correction and backoff follow-ups. Own-process settlement still matters; failed settlement has explicit failure evidence. | Human input in another tab is not automatically Runner cancellation. Explicit cancellation and abrupt Runner loss need separate decisions. |

Sources: [ADR-0001][retry-adr], [operation implementations][operations],
[executor implementation][executor], [spec retry rules][spec-retry],
[repair budgets][repair-budgets]. Existing deterministic tests include
[operations][operation-tests], `config-retry.test.ts`,
`sandcastle-native-recovery.test.ts`, `sandcastle-execution.test.ts`,
`sandcastle-results.test.ts`, `sandcastle-stop-conditions.test.ts`,
`sandcastle-output-stop.test.ts` and `cli-conflict-budget.test.ts`.
The blocked-budget discrepancy is demonstrated by
[the blocked CI repair test][blocked-repair-test] and the common blocked branch
in [the Agent wrapper][blocked-branch]; the repair counter advances only after
the wrapper returns to [repair orchestration][repairs].

Result schemas are stricter than "some JSON appeared": exact permitted fields,
nonempty summaries/check details, supported outcomes/statuses, full commit
SHAs, commit/outcome constraints, and purpose-specific PR metadata.
Implementation acceptance checks the expected absolute Worktree, branch,
recorded base, clean working copy, nonempty actual commits and exact agreement
with claimed commits. Review acceptance rejects reviewer-created commits and
dirty state. Preserve these checks when moving
`src/adapters/sandcastle-output.ts` parsing out of the Sandcastle-specific
adapter. Its `StructuredOutputError` recovery helpers can be replaced without
discarding its validation. Sources: [schemas][schemas],
[Git acceptance][git-acceptance], [Review acceptance][review-acceptance].

Fixed policy timing outside Agent interaction also survives: 30-second
required-check discovery after create/repair push; configured check/merge-queue
waits; `code_host` ticket closure observation after 10 seconds and another
30 seconds. The source's Agent idle/overall thresholds are intervention
thresholds, not permission to interpret a terminal's idle appearance as task
completion. Sources: [publication rules][spec-publication],
[closure rules][spec-closure], [timeout supervision][supervision].

## Pause inventory and intentional removals

The following lists behavior to map, not proposed replacement policy. Removing
Agent-session Operator Pause must not accidentally remove non-Agent pauses
that happen during an Agent phase, such as Git verification reads or audit
failures. The [source operations][operations], [Agent wrapper][agent-operation],
[Review wrapper][review], [supervision][supervision] and
[Run coordination][coordination] implement distinct branches.

| Existing branch | Existing response/guarantee | Status in the new planning effort |
| --- | --- | --- |
| Schema-valid Agent `blocked`, including implementation/fix/repair/documentation and reviewer blocker | Preserve blocker; pause the applicable conversation. Usable session: Enter means continue; other text supplies instructions; skip/cancel are supported. Non-continuable diagnostics allow retry/skip/cancel but not arbitrary instructions. | Agent-pause UI removed; lifecycle ticket must say how each purpose waits, fails, or resolves through direct interaction and a subsequent validated handoff. |
| Agent execution/probe/output exhaustion, missing/unusable exact session | Preserve diagnostic identity/context. Continuable failure resumes the same session; a non-continuable pause can start a fresh attempt on explicit retry. No automatic fresh-conversation fallback. | Replacement outcome unresolved; preserve bounded attempts and distinguish a fresh task from a required continuation. |
| Invalid Git handoff, dirty/mismatched state, false commit claims, invalid findings file or reviewer-created commits | Reject publication, retain evidence, allow only ordinary validated continuation/retry paths. A review fix reporting no-change is rejected. | Validation remains mandatory; specify interaction/failure behavior after rejection. |
| Idle/overall Agent threshold | Retain the live invocation and outcome. Enter keeps waiting/accepts retained outcome; idle rearms while overall elapsed time is retained and overall notifies once. `k` stops only the selected invocation, confirms settlement/native storage, then remains paused for manual exact-session takeover; Enter after manual exit resumes. | This pause/kill/manual-resume/acknowledge UI is removed. New timeout and direct-input ordering must be explicit. No implied hard kill or unlimited retry. |
| Failed/uncertain process cleanup | `process_cleanup` diagnostics are nonretryable; no new automatic writer or cleanup of an unsafe Worktree. Wrapper rethrows this failure instead of ordinary Agent continuation. | Safety gate remains; terminal closure or a result file is insufficient proof of settlement. |
| Failed external read after Operation Retry | Enter retries observation with a fresh bounded budget; cancellation; selected-issue scope may skip. | Preserve non-Agent pause, including observations made during Agent-associated work. |
| Failed safe/local workflow write | Automatic budget only when opted in, then Enter retries original operation; revalidate where configured. Unobserved creations may leave unknown resources. | Preserve; do not add implicit resource replay/deduplication as transport migration. |
| Required-check timeout/failure observation | Timeout enters non-Agent pause without consuming repair; fresh observation on retry can proceed, repair, or wait again. | Preserve. |
| Exhausted CI/conflict repair budget | Refresh current checks/conflict; if still needed, operator retry authorizes a fresh two-attempt generation. | Preserve non-Agent repair-budget authorization separately from removed Agent-session pauses. |
| Merge request rejection, merge queue wait failure/timeout | Refresh PR/head on retry; merged proceeds, queued waits, otherwise retry request. Explicit conflict alone selects conflict repair. | Preserve. |
| Missing post-merge `closed/completed`, closure/release/cleanup failure, recovery-state inconsistency | Retry the current evidence checks or remaining operation; do not manufacture completion or abandon partial cleanup silently. | Preserve non-Agent pause and ownership evidence. |
| Audit creation/append failure | Only Enter retries the same audit action; `q`/EOF cancels. Skip and supplied JSON/success text are unsupported. Never replay an already completed business action. | Preserve. |
| Startup invalid config/secrets/prompts, unsupported cross-repository children, contradictory parent, ordinary unresolved business outcome | Bypass Operator Pause and return the defined terminal outcome. | Preserve. |

Non-Agent pause scope matters: selected-issue operations from Reservation
through cleanup offer `s`; shared discovery/startup/batch fetch/final parent
closure do not. Maintenance preparation can skip an occurrence before a
Maintenance Ticket exists. Unsupported input remains paused. Skip retains
side effects, prevents reselection in that Run, attempts pre-publication
Reservation release, and reports residue/unknown resources. Skipped or
unfinished cleanup returns `incomplete`. Sources:
[pause rules][spec-retry], [operations][operations],
`tests/run/cli-operation-skip.test.ts`, `cli-post-publication-skip.test.ts`,
`cli-maintenance-skip.test.ts`, `cli-skip.test.ts`.

Existing non-Agent Run-wide gating must remain: observations/in-flight output
can finish while a pause is pending, but new dispatch, verification,
publication and integration are gated until every pending intervention is
resolved. Releasing one pause cannot release another. Replacing Agent-pause
coordination must preserve this behavior for the remaining non-Agent pauses.
Sources: [coordination][coordination], [Run pause tests][run-pause-tests].

The other agreed removal is **Runner-recorded conversation transcripts**.
Keep workflow audits, findings needed by the review/fix loop, task handoffs,
Recovery Snapshots, and native CLI history needed to resume. Some current
`agent-logs.ts` and `operation-audit.ts` cleanup routines also remove findings
Markdown; they cannot simply be deleted as "logging". Sources:
[Agent log ownership][agent-logs], [operation audit][operation-audit],
[Review loop][review].

## Lifecycle and resource extraction hazards

1. **Settlement and conversational continuity are different.** The old executor
   waits for both Sandcastle return and explicit host settlement before probe
   follow-up, task, retry, correction, verification and replacement. A retained
   interactive CLI intentionally stays alive after a file handoff. The new
   contract must define the quiescent handoff/writer boundary that permits
   verification and later prompts, while still requiring real process
   settlement before deletion or competing replacement execution. This is a
   changed mechanism with preserved safety intent, not literal reuse of a
   "process must exit after every turn" implementation. Sources:
   [settlement adapter][settlement], [cleanup gate tests][cleanup-gate-tests].
2. **Terminal existence is not Agent identity.** Open tab, shell with exited
   Agent, native conversation reference, pending invocation, and reconnectable
   environment locator need distinct evidence. The agreed live-tab rule must
   avoid typing a task into a shell or launching duplicate resume. This is a
   requirement from the [map][map], not an old Sandcastle capability.
3. **Temporary config lifetime changes.** Implementation and Review create
   per-call `GIT_CONFIG_GLOBAL` files and delete the directory in `finally`.
   A long-lived externally owned CLI may still refer to that path across
   later turns or Runner loss. Preserve isolation from the user's global Git
   configuration, but decide resource lifetime before copying those `finally`
   blocks unchanged. Sources: [attempt config lifetime][config-lifetime],
   [Review config lifetime][review], [supervision environment][supervision].
4. **Repair workspace replacement remains real behavior.** The production Git
   path creates a new local repair branch/Worktree from the current stable
   remote head and retains the original PR/remote branch. Successful repair
   retires replaced resources with persisted partial-cleanup evidence.
   Interactive tab ownership must follow the actual workspace identities;
   "one issue = one Worktree/tab forever" is not an accurate extraction rule.
   Sources: [fresh repair][fresh-repair], [repair implementation][repairs],
   [repair lifecycle tests][repair-lifecycle-tests].
5. **Completion cleanup has exceptions.** Issue completion can close all its
   owned implementation/reviewer/repair/replacement tabs, then remove safe
   disposable resources. Intermediate handoff is not completion, and
   `--no-auto-merge` preserves unmerged delivery artifacts. Native history,
   workflow audit and recoverable interrupted work must not be deleted just
   because Runner exited. Sources: [cleanup][cleanup],
   [CLI contract][spec-startup], [map requirements][map].
6. **Progress is currently session-free.** `createProgress` prints
   `issue-N: <phase>` with optional retry suffix, only when substantive
   execution starts. Probes/completion are silent. Adding actual `sessionid`
   across initial dispatch, fixes and replacement tabs needs a session-aware
   progress input and a rule before identity is known. Sources:
   [progress implementation][progress], [progress tests][progress-tests].

## Recovery: existing behavior and requested expansion

The existing recovery is richer than a saved phase but deliberately excludes
durable conversation state. Repeating the delivery-scoped CLI selection
loads an identity-checked Recovery Snapshot. It saves active/history batches,
completed delivery labels, maintenance barrier/state, cleanup candidates,
publication intents and evidence, PR/head identity, pending repair pushes,
and independent repair budgets/generations. Writes sync a temporary file and
rename; audit files are never replayed as recovery input. Sources:
[snapshot schema and I/O][recovery], [CLI restore][cli-restore],
[source recovery rules][spec-recovery].

| Restart case | Existing behavior |
| --- | --- |
| Unfinished pre-publication implementation | Fresh CLI `runId`, new executor with empty session map, recovered pending Batch routed through implementation again, fresh branch/Worktree/session object. It does not resume the previous working conversation or automatically adopt arbitrary unrecorded artifacts. |
| Pending push with matching remote head | Adopt exact recorded publication evidence and continue. |
| Pending push with absent remote branch | Abandon that publication intent and restart implementation as fresh work. |
| Unexpected remote advance or conflicting PR identity | Pause for reconciliation; do not overwrite, force-push, or blindly create a replacement. |
| Exact PR already exists / recorded PR | Continue reads, required checks, integration and closure without rerunning implementation. |
| Repair completed/push pending | Use persisted stable-remote/head/repair evidence to reconcile; recorded repair Worktree/branch can remain relevant. Pending old cleanup may be retried. Worktrees are therefore not universally recreated on every restart. |
| Automatic maintenance interrupted | Resume stored occurrence while its startup trigger still matches delivery-time evidence; otherwise stop automatic continuation and retain/report artifacts. |
| Standalone `--document` | Always a fresh occurrence; deliberately reads/writes no delivery Recovery Snapshot. It does not inherit cross-Runner recovery from delivery scope. |
| `q`/EOF versus abrupt OS kill | Explicit cancellation aborts and settles owned invocations before normal unwind. OS termination is a distinct interruption; old-process management is excluded. Do not assume normal `finally` cleanup ran after a kill. |

Sources: [CLI Run identity/loading][cli-restore],
[batch recovery routing][batch-recovery], [publication reconciliation][publication-recovery],
[repair identity][repair-identity], [maintenance rules][spec-maintenance],
[Run cancellation definition][cancellation-definition].
Tests: [restart scenarios][restart-tests], `tests/recovery.test.ts`,
`tests/run/cleanup.test.ts`, `cli-cancellation.test.ts`,
`cli-config-reservation.test.ts`, [repair lifecycle][repair-lifecycle-tests].

Durable native conversation restoration is an **intentional expansion** of
the old [explicitly excluded scope][spec-exclusions]. A session ID alone is
insufficient. The recovery decision must consider original working copy
(including unfinished changes), branch/base and Review HEAD/findings, separate
implementation/reviewer identities, command/model/options/environment/storage,
temporary configuration lifetime, environment/terminal ownership, assigned
prompt/probe/result paths, dispatch/acceptance state, and retry budgets.

A plausible sequence for the human recovery decision to evaluate is: load and
validate owned state; inspect assigned final result files first; reconcile an
already accepted result; query the environment afresh; observe/reuse a surviving
original conversation; otherwise safely resume the exact native reference.
This is an inference from the file-handoff proposal, not a settled algorithm.
It must address a crash between sending a prompt and persisting its
acknowledgement: queue admission does not prove Agent consumption, so blind
replay cannot promise exactly-once execution. Context restoration also does
not restore an interrupted tool call or prove that an old writer stopped.

## Extraction seams and verification reuse

| Keep/adapt in Core | Replace or move at the execution boundary |
| --- | --- |
| `src/run/run.ts`, `run-batch.ts`, `standalone-run.ts`, discovery/reservations, maintenance, publication/repair/recovery/cleanup, audit/report, Git and GitHub adapters | `src/adapters/sandcastle.ts` orchestration of Sandcastle invocation and provider stream/output extraction |
| Business contracts in `src/run/contracts.ts`; deterministic `Clock`, `Tracker`, `CodeHost`, `GitWorkspace`, `OperatorIO` boundaries | Sandcastle-native factory/storage assumptions in `agent-provider.ts` and `codebuddy.ts`; configured generic CLI start/resume becomes Core policy |
| Runner-owned prompt content/context, strict result validators, independent Git/Review acceptance, bounded policy counters | Sandcastle result tags/completion signals, `StructuredOutputError` coupling, host-owned process wrapper where multiplexer ownership differs |
| `operations.ts`, audit-safe retries, non-Agent pause scoping and Run gating | Agent-only pause/timeout/manual-takeover input paths in `agent-pause.ts`, relevant `operations.ts` branches and `agent-supervision.ts` |
| Audit/recovery evidence, necessary review findings, owned resource cleanup and progress phase semantics | Transcript capture and transcript-derived session keys; progress payload gains actual native identity |
| Core-level execution/session/handoff/recovery policy and public environment contracts | Herdr owns targeted terminal creation, argv launch/quoting, literal submission/keys, authoritative available lifecycle evidence and close; Core does not import Herdr internals |

This is an extraction candidate list, not a command to copy files unchanged.
Execution concerns are spread across the adapter **and** attempt, review,
progress, audit and pause orchestration. The [six source boundaries][spec-boundaries]
provide the useful test seams; an extra filesystem port or broad per-helper
mock layer is not required.

Carry the full [composed workflow tests][full-contract-tests] and scripted
dependencies in `tests/support/cli-dependencies.ts`,
`cli-project.ts`, `full-contract-scenario.ts` forward as behavioral evidence.
Adapt the AgentExecutor fake to file/submission/session contracts while keeping
assertions on visible selection, operation order, batches, merge barriers,
results, terminal outcomes and exit codes. Keep local real Git tests for
branch/base/dirty/commit verification. The old host-process lifecycle tests
establish only their measured ownership cases and should become safety
requirements/new adapter tests where the mechanism changes, rather than being
claimed as proof of Herdr process control. Sources:
[testing decisions][spec-tests], [cleanup gate tests][cleanup-gate-tests],
`sandcastle-process-lifecycle.test.ts`, `no-shell-sandbox.test.ts`.

New evidence still needed after decisions: adapter contract checks, file
partial/malformed/stale/duplicate/missing handoffs, startup readiness and
multiline submission, input arbitration, retained-tab versus exact resume,
Runner-only/multiplexer restart, uncertain prompt dispatch, once-only result
acceptance, safe Issue tab/Worktree cleanup, and local/multi-package `npx`
plugin discovery. None is proven by the old fake AgentExecutor.

## Questions left to the human decisions

- [Decide interactive Agent startup, continuation, and failure handling][lifecycle-ticket]:
  readiness, operator/automatic input ordering, open-shell detection, and the
  replacement for every removed Agent pause branch without hidden success or
  unlimited retries.
- [Decide file handoff, writer ownership, and Issue cleanup][handoff-ticket]:
  accepted-result quiescence, surviving CLI/descendant writers, exact file
  ownership, safe cleanup and resource/configuration lifetimes.
- [Decide durable recovery of native conversations and in-flight work][recovery-ticket]:
  persistence transitions, original Worktree/conversation restoration, ambiguous
  dispatch, cancellation versus interruption, lost history, and standalone
  `--document` inclusion.
- [Define the public terminal plugin contract and compatibility boundary][contract-ticket]:
  which ownership/lifecycle facts can be required, optional or unsupported;
  errors/uncertainty and compatibility tests; independent development against
  public Core contracts.
- [Decide plugin discovery, package distribution, and supported installations][packaging-ticket]:
  runtime/platform and local/`npx` layouts, selected-package discovery and
  compatibility before effects; explicit global/mixed-layout boundaries.
- [Specify Herdr plugin requirements and publish its implementation spec][herdr-ticket]:
  adapter capabilities and test ownership once the upstream contracts settle.

These questions already have sharp decision tickets; this investigation adds
no duplicate tickets and resolves no human tradeoff.

## Checks performed and limits

Fresh checks: source `main` identity, local runtime/test equivalence to the
pinned baseline, focused source/spec/test inspection, and note/diff/link-target
checks. No runtime code changed.

Earlier in this investigation thread, the following existing tests were run
against the same local runtime/test content: `cli-restart-parent.test.ts`,
`cli-review-rounds.test.ts`, `sandcastle-native-recovery.test.ts`, and
`tests/recovery.test.ts`: **24 passed, 0 failed**. They were not rerun for this
inventory. Other tests listed here were inspected as reuse seams, not claimed
to have been freshly executed or to be a fully passing migration suite.

No authenticated Agent execution, real Herdr lifecycle experiment, abrupt-kill
test, live delivery mutation, package installation/publication or production
extraction was performed. Old scripted tests do not establish the new
environment's real compatibility or writer-settlement guarantees.

[ticket]: https://github.com/BuddyLabsCo/issue-runner-core/issues/4
[map]: https://github.com/BuddyLabsCo/issue-runner-core/issues/3
[design]: https://github.com/BuddyLabsCo/issue-runner-core/blob/fac5a93097d0c45d8448d555e5c650229c62446f/docs/design.md
[lifecycle-ticket]: https://github.com/BuddyLabsCo/issue-runner-core/issues/5
[handoff-ticket]: https://github.com/BuddyLabsCo/issue-runner-core/issues/6
[recovery-ticket]: https://github.com/BuddyLabsCo/issue-runner-core/issues/7
[contract-ticket]: https://github.com/BuddyLabsCo/issue-runner-core/issues/8
[packaging-ticket]: https://github.com/BuddyLabsCo/issue-runner-core/issues/9
[herdr-ticket]: https://github.com/BuddyLabsCo/issue-runner-core/issues/10
[spec]: https://github.com/BuddyLabsCo/sandcastle-runner/blob/0adf499bf69217b56256ca2affb1c0dca0894110/docs/specs/v1-orchestration.md
[spec-startup]: https://github.com/BuddyLabsCo/sandcastle-runner/blob/0adf499bf69217b56256ca2affb1c0dca0894110/docs/specs/v1-orchestration.md#L82-L93
[spec-discovery]: https://github.com/BuddyLabsCo/sandcastle-runner/blob/0adf499bf69217b56256ca2affb1c0dca0894110/docs/specs/v1-orchestration.md#L95-L105
[spec-execution]: https://github.com/BuddyLabsCo/sandcastle-runner/blob/0adf499bf69217b56256ca2affb1c0dca0894110/docs/specs/v1-orchestration.md#L107-L129
[spec-review]: https://github.com/BuddyLabsCo/sandcastle-runner/blob/0adf499bf69217b56256ca2affb1c0dca0894110/docs/specs/v1-orchestration.md#L119-L129
[spec-publication]: https://github.com/BuddyLabsCo/sandcastle-runner/blob/0adf499bf69217b56256ca2affb1c0dca0894110/docs/specs/v1-orchestration.md#L131-L143
[spec-closure]: https://github.com/BuddyLabsCo/sandcastle-runner/blob/0adf499bf69217b56256ca2affb1c0dca0894110/docs/specs/v1-orchestration.md#L145-L150
[spec-maintenance]: https://github.com/BuddyLabsCo/sandcastle-runner/blob/0adf499bf69217b56256ca2affb1c0dca0894110/docs/specs/v1-orchestration.md#L152-L161
[spec-recovery]: https://github.com/BuddyLabsCo/sandcastle-runner/blob/0adf499bf69217b56256ca2affb1c0dca0894110/docs/specs/v1-orchestration.md#L163-L169
[spec-retry]: https://github.com/BuddyLabsCo/sandcastle-runner/blob/0adf499bf69217b56256ca2affb1c0dca0894110/docs/specs/v1-orchestration.md#L170-L182
[spec-audit]: https://github.com/BuddyLabsCo/sandcastle-runner/blob/0adf499bf69217b56256ca2affb1c0dca0894110/docs/specs/v1-orchestration.md#L184-L190
[spec-boundaries]: https://github.com/BuddyLabsCo/sandcastle-runner/blob/0adf499bf69217b56256ca2affb1c0dca0894110/docs/specs/v1-orchestration.md#L192-L200
[spec-tests]: https://github.com/BuddyLabsCo/sandcastle-runner/blob/0adf499bf69217b56256ca2affb1c0dca0894110/docs/specs/v1-orchestration.md#L202-L215
[spec-exclusions]: https://github.com/BuddyLabsCo/sandcastle-runner/blob/0adf499bf69217b56256ca2affb1c0dca0894110/docs/specs/v1-orchestration.md#L219-L227
[retry-adr]: https://github.com/BuddyLabsCo/sandcastle-runner/blob/0adf499bf69217b56256ca2affb1c0dca0894110/docs/adr/0001-configurable-retry-policy.md
[provider]: https://github.com/BuddyLabsCo/sandcastle-runner/blob/0adf499bf69217b56256ca2affb1c0dca0894110/src/adapters/agent-provider.ts#L10-L25
[attempt]: https://github.com/BuddyLabsCo/sandcastle-runner/blob/0adf499bf69217b56256ca2affb1c0dca0894110/src/run/attempt.ts
[agent-operation]: https://github.com/BuddyLabsCo/sandcastle-runner/blob/0adf499bf69217b56256ca2affb1c0dca0894110/src/run/agent-operation.ts#L43-L298
[git-acceptance]: https://github.com/BuddyLabsCo/sandcastle-runner/blob/0adf499bf69217b56256ca2affb1c0dca0894110/src/run/agent-operation.ts#L332-L437
[review]: https://github.com/BuddyLabsCo/sandcastle-runner/blob/0adf499bf69217b56256ca2affb1c0dca0894110/src/run/review-attempt.ts
[review-acceptance]: https://github.com/BuddyLabsCo/sandcastle-runner/blob/0adf499bf69217b56256ca2affb1c0dca0894110/src/run/review-attempt.ts#L51-L85
[executor]: https://github.com/BuddyLabsCo/sandcastle-runner/blob/0adf499bf69217b56256ca2affb1c0dca0894110/src/adapters/sandcastle.ts
[executor-state]: https://github.com/BuddyLabsCo/sandcastle-runner/blob/0adf499bf69217b56256ca2affb1c0dca0894110/src/adapters/sandcastle.ts#L127-L143
[schemas]: https://github.com/BuddyLabsCo/sandcastle-runner/blob/0adf499bf69217b56256ca2affb1c0dca0894110/src/adapters/sandcastle-output.ts#L75-L253
[prompts]: https://github.com/BuddyLabsCo/sandcastle-runner/tree/0adf499bf69217b56256ca2affb1c0dca0894110/src/prompts
[operations]: https://github.com/BuddyLabsCo/sandcastle-runner/blob/0adf499bf69217b56256ca2affb1c0dca0894110/src/run/operations.ts
[coordination]: https://github.com/BuddyLabsCo/sandcastle-runner/blob/0adf499bf69217b56256ca2affb1c0dca0894110/src/run/run-coordination.ts
[settlement]: https://github.com/BuddyLabsCo/sandcastle-runner/blob/0adf499bf69217b56256ca2affb1c0dca0894110/src/adapters/process-settlement.ts#L29-L75
[supervision]: https://github.com/BuddyLabsCo/sandcastle-runner/blob/0adf499bf69217b56256ca2affb1c0dca0894110/src/adapters/agent-supervision.ts
[config-lifetime]: https://github.com/BuddyLabsCo/sandcastle-runner/blob/0adf499bf69217b56256ca2affb1c0dca0894110/src/run/agent-operation.ts#L235-L298
[fresh-repair]: https://github.com/BuddyLabsCo/sandcastle-runner/blob/0adf499bf69217b56256ca2affb1c0dca0894110/src/run/pull-request-core.ts#L175-L233
[repair-budgets]: https://github.com/BuddyLabsCo/sandcastle-runner/blob/0adf499bf69217b56256ca2affb1c0dca0894110/src/run/pull-request-core.ts#L76-L137
[repairs]: https://github.com/BuddyLabsCo/sandcastle-runner/blob/0adf499bf69217b56256ca2affb1c0dca0894110/src/run/pull-request-repair.ts
[repair-identity]: https://github.com/BuddyLabsCo/sandcastle-runner/blob/0adf499bf69217b56256ca2affb1c0dca0894110/src/run/pull-request-repair.ts#L53-L71
[cleanup]: https://github.com/BuddyLabsCo/sandcastle-runner/blob/0adf499bf69217b56256ca2affb1c0dca0894110/src/run/cleanup.ts
[cleanup-coordination]: https://github.com/BuddyLabsCo/sandcastle-runner/blob/0adf499bf69217b56256ca2affb1c0dca0894110/src/run/run.ts#L451-L585
[agent-logs]: https://github.com/BuddyLabsCo/sandcastle-runner/blob/0adf499bf69217b56256ca2affb1c0dca0894110/src/run/agent-logs.ts
[operation-audit]: https://github.com/BuddyLabsCo/sandcastle-runner/blob/0adf499bf69217b56256ca2affb1c0dca0894110/src/run/operation-audit.ts
[progress]: https://github.com/BuddyLabsCo/sandcastle-runner/blob/0adf499bf69217b56256ca2affb1c0dca0894110/src/run/progress.ts
[recovery]: https://github.com/BuddyLabsCo/sandcastle-runner/blob/0adf499bf69217b56256ca2affb1c0dca0894110/src/recovery.ts
[cli-restore]: https://github.com/BuddyLabsCo/sandcastle-runner/blob/0adf499bf69217b56256ca2affb1c0dca0894110/src/cli.ts#L590-L691
[batch-recovery]: https://github.com/BuddyLabsCo/sandcastle-runner/blob/0adf499bf69217b56256ca2affb1c0dca0894110/src/run/run.ts#L959-L1005
[publication-recovery]: https://github.com/BuddyLabsCo/sandcastle-runner/blob/0adf499bf69217b56256ca2affb1c0dca0894110/src/run/pull-request-recovery.ts
[cancellation-definition]: https://github.com/BuddyLabsCo/sandcastle-runner/blob/0adf499bf69217b56256ca2affb1c0dca0894110/CONTEXT.md#L83-L85
[git-workspace]: https://github.com/BuddyLabsCo/sandcastle-runner/blob/0adf499bf69217b56256ca2affb1c0dca0894110/src/adapters/git-workspace.ts
[startup-tests]: https://github.com/BuddyLabsCo/sandcastle-runner/blob/0adf499bf69217b56256ca2affb1c0dca0894110/tests/run/cli-startup-errors.test.ts
[eligibility-tests]: https://github.com/BuddyLabsCo/sandcastle-runner/blob/0adf499bf69217b56256ca2affb1c0dca0894110/tests/run/cli-eligibility.test.ts
[git-tests]: https://github.com/BuddyLabsCo/sandcastle-runner/blob/0adf499bf69217b56256ca2affb1c0dca0894110/tests/adapters/git-workspace.test.ts
[review-tests]: https://github.com/BuddyLabsCo/sandcastle-runner/blob/0adf499bf69217b56256ca2affb1c0dca0894110/tests/run/cli-review.test.ts
[round-tests]: https://github.com/BuddyLabsCo/sandcastle-runner/blob/0adf499bf69217b56256ca2affb1c0dca0894110/tests/run/cli-review-rounds.test.ts
[blocked-repair-test]: https://github.com/BuddyLabsCo/sandcastle-runner/blob/0adf499bf69217b56256ca2affb1c0dca0894110/tests/run/cli-ci-repair.test.ts#L125
[blocked-branch]: https://github.com/BuddyLabsCo/sandcastle-runner/blob/0adf499bf69217b56256ca2affb1c0dca0894110/src/run/agent-operation.ts#L301-L334
[operation-tests]: https://github.com/BuddyLabsCo/sandcastle-runner/blob/0adf499bf69217b56256ca2affb1c0dca0894110/tests/run/operations.test.ts
[run-pause-tests]: https://github.com/BuddyLabsCo/sandcastle-runner/blob/0adf499bf69217b56256ca2affb1c0dca0894110/tests/run/cli-run-pause.test.ts
[cleanup-gate-tests]: https://github.com/BuddyLabsCo/sandcastle-runner/blob/0adf499bf69217b56256ca2affb1c0dca0894110/tests/adapters/sandcastle-cleanup-gate.test.ts
[repair-lifecycle-tests]: https://github.com/BuddyLabsCo/sandcastle-runner/blob/0adf499bf69217b56256ca2affb1c0dca0894110/tests/run/worktree-repair-lifecycle.test.ts
[progress-tests]: https://github.com/BuddyLabsCo/sandcastle-runner/blob/0adf499bf69217b56256ca2affb1c0dca0894110/tests/run/cli-progress.test.ts
[restart-tests]: https://github.com/BuddyLabsCo/sandcastle-runner/blob/0adf499bf69217b56256ca2affb1c0dca0894110/tests/run/cli-restart-parent.test.ts
[full-contract-tests]: https://github.com/BuddyLabsCo/sandcastle-runner/blob/0adf499bf69217b56256ca2affb1c0dca0894110/tests/run/full-contract.test.ts
