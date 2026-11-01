# Test-by-test audit

All 556 test entries from the previous passing run were checked against their setup, assertions, shared implementation and overlapping scenarios. Parameterized entries appear separately below. Input loops inside one test remain part of that entry.

The revision removes or absorbs 53 old entries and adds 2 consolidated scenarios, leaving 505 entries. It does not reduce counts by hiding unchanged scenarios inside loops. Distinct recovery checkpoints, uncertain remote effects, ownership checks and platform contracts remain.

“Keep” means the scenario remains at its listed owner. Removed entries name the remaining coverage and the reason. Links on retained groups point to the current source; deleted files are listed without links.

Validation: `npm run verify` passed on Linux with Node 22.18.0 and npm 11.6.2: 504 passed, one existing Windows-only skip, zero failures. Test execution took 30.8 seconds. Hosted Windows CI was not run locally.

The optional structural scanner did not pass its heuristic gate. It flagged recent edits and marked three `createPullRequest` methods as dead after removal of the direct fixture test. Calls remain in `src/run/publication.ts`, `src/run/run.ts`, and the repair fixture; the passing publication and Batch scenarios exercise them through the CodeHost interface. No runtime source files changed. The scanner findings were reviewed rather than suppressed.

## Consolidated scenarios

- lost readiness after Reservation prevents dispatch and retains ownership markers
- near-match delivery labels never trigger documentation

## Decisions

### [adapters/cli-ci-repair-git.test.ts](../tests/adapters/cli-ci-repair-git.test.ts)

| Previous test | Decision | Remaining coverage / reason |
| --- | --- | --- |
| real Git ci repairs preserve the original PR branch | Keep | Same owner. |
| real Git ci repairs preserve the original PR branch after rejecting invalid Git evidence | Keep | Same owner. |
| real Git conflict repairs preserve the original PR branch | Keep | Same owner. |
| real Git conflict repairs preserve the original PR branch after rejecting invalid Git evidence | Keep | Same owner. |

### [adapters/cli-documentation-git.test.ts](../tests/adapters/cli-documentation-git.test.ts)

| Previous test | Decision | Remaining coverage / reason |
| --- | --- | --- |
| standalone documentation committed verifies real Git and cleans only owned resources | Keep | Same owner. |
| standalone documentation recovered verifies real Git and cleans only owned resources | Keep | Same owner. |
| standalone documentation repaired verifies real Git and cleans only owned resources | Keep | Same owner. |
| standalone documentation no_change verifies real Git and cleans only owned resources | Keep | Same owner. |
| standalone documentation ownership_changed verifies real Git and cleans only owned resources | Keep | Same owner. |
| standalone documentation branch_in_use verifies real Git and cleans only owned resources | Keep | Same owner. |

### [adapters/cli-documentation-host.test.ts](../tests/adapters/cli-documentation-host.test.ts)

| Previous test | Decision | Remaining coverage / reason |
| --- | --- | --- |
| GitHub documentation scans label pages, reconciles label creation, and creates an ordinary Maintenance Ticket | Keep | Same owner. |

### [adapters/cli-implementation-git.test.ts](../tests/adapters/cli-implementation-git.test.ts)

| Previous test | Decision | Remaining coverage / reason |
| --- | --- | --- |
| a real Git changed execution is independently checked through a complete Run | Keep | Same owner. |
| a real Git empty execution is independently checked through a complete Run | Keep | Same owner. |
| a real Git remote-advance execution is independently checked through a complete Run | Keep | Same owner. |
| a real Git dirty-cancel execution is independently checked through a complete Run | Keep | Same owner. |
| a real Git restart execution is independently checked through a complete Run | Keep | Same owner. |
| a concurrent Batch uses a fresh fetched base and isolated real Git Worktrees and configurations | Keep | Same owner. |

### [adapters/cli-integration-host.test.ts](../tests/adapters/cli-integration-host.test.ts)

| Previous test | Decision | Remaining coverage / reason |
| --- | --- | --- |
| GitHub integration uses squash, observed HEAD, admin policy, queue observation and completed closure | Keep | Same owner. |
| GitHub classifies Pull Request cannot be cleanly created and retains the original cause | Keep | Same owner. |
| GitHub classifies Merge conflict in README and retains the original cause | Keep | Same owner. |
| GitHub classifies branch protection rule prevents merging and retains the original cause | Keep | Same owner. |
| GitHub classifies HTTP 503: service unavailable and retains the original cause | Keep | Same owner. |
| an invalid GitHub merge observation cannot close the Issue or earn delivery credit | Keep | Same owner. |

### [adapters/cli-publication-host.test.ts](../tests/adapters/cli-publication-host.test.ts)

| Previous test | Decision | Remaining coverage / reason |
| --- | --- | --- |
| publication reconciles canonical repository casing with lowercase configuration and exact multiline metadata | Keep | Same owner. |

### [adapters/cli-review-git.test.ts](../tests/adapters/cli-review-git.test.ts)

| Previous test | Decision | Remaining coverage / reason |
| --- | --- | --- |
| real Git rejects reviewer edits and recovers a final-round fix with its staged work and accumulated commits | Keep | Same owner. |

### [adapters/cli-worktree-paths.test.ts](../tests/adapters/cli-worktree-paths.test.ts)

| Previous test | Decision | Remaining coverage / reason |
| --- | --- | --- |
| real Git verifies and cleans the same Worktree through a directory alias | Keep | Same owner. |
| real Git verifies and cleans the same Worktree through a short alias | Keep | Same owner. |

### [agent/handoff.test.ts](../tests/agent/handoff.test.ts)

| Previous test | Decision | Remaining coverage / reason |
| --- | --- | --- |
| execution handoff rejects invalid JSON | Keep | Same owner. |
| execution handoff rejects non-object JSON | Keep | Same owner. |
| execution handoff rejects missing fields | Keep | Same owner. |
| execution handoff rejects legacy fields | Keep | Same owner. |
| execution handoff rejects Review outcome | Keep | Same owner. |
| execution handoff rejects empty summary | Keep | Same owner. |
| execution handoff rejects non-array commits | Keep | Same owner. |
| execution handoff rejects invalid commit | Keep | Same owner. |
| execution handoff rejects missing committed evidence | Keep | Same owner. |
| execution handoff rejects duplicate commits | Keep | Same owner. |
| execution handoffs accept committed and no_change results | Keep | Same owner. |
| Review handoff rejects wrong purpose | Keep | Same owner. |
| Review handoff rejects extra field | Keep | Same owner. |
| Review handoff rejects empty summary | Keep | Same owner. |
| Review handoff rejects claimed commits | Keep | Same owner. |
| Review handoff rejects passed findings | Keep | Same owner. |
| Review handoff rejects wrong findings path | Keep | Same owner. |
| Review handoff rejects relative findings path | Keep | Same owner. |
| Review handoffs accept passed and assigned findings results | Keep | Same owner. |

### `issue-runner-handoff.test.mjs`

| Previous test | Decision | Remaining coverage / reason |
| --- | --- | --- |
| explicit handoff skill defines the result and ends all work at publication | Remove / merge | agent/handoff parser; package installed asset equality. Exact English sentence matching cannot establish instruction meaning; parser and packaged-asset contracts remain. |

### [package.test.mjs](../tests/package.test.mjs)

| Previous test | Decision | Remaining coverage / reason |
| --- | --- | --- |
| built artifacts work in isolated consumer and npm global installations | Keep | Same owner. |

### [package/installed-artifacts.mjs](../tests/package/installed-artifacts.mjs)

| Previous test | Decision | Remaining coverage / reason |
| --- | --- | --- |
| npm's installed executable runs outside the checkout and initializes bundled templates | Keep | Same owner. |
| installed public types compile from the independent plugin | Keep | Same owner. |
| installed purpose prompts load and the manual handoff asset matches exactly | Keep | Same owner. |
| installed prompts cannot fall back to the checkout | Keep | Same owner. |

### [package/terminal-plugin.mjs](../tests/package/terminal-plugin.mjs)

| Previous test | Decision | Remaining coverage / reason |
| --- | --- | --- |
| Core and a private plugin tarball share the custom global prefix | Keep | Same owner. |
| only the selected public import entry initializes, before an empty Run | Keep | Same owner. |
| a sibling link cannot supply a plugin from another prefix | Keep | Same owner. |
| invalid environment names fail before constructing a package name | Keep | Same owner. |
| environment selection accepts names beyond built-in terminal brands | Keep | Same owner. |
| each returned method must be callable before workflow startup | Keep | Same owner. |
| broken package metadata and an unavailable public entry are actionable | Keep | Same owner. |
| Project packages, another prefix, PATH, NODE_PATH, and npm caches cannot substitute | Keep | Same owner. |
| a nested Core dependency cannot masquerade as the selected sibling | Keep | Same owner. |
| a public entry cannot escape the selected package through a link | Keep | Same owner. |
| a public entry with leading dots stays within the selected package | Keep | Same owner. |
| a relocated global installation resolves beside the executing Core | Keep | Same owner. |

### [run/cli-batch-documentation-delivery-recovery.test.ts](../tests/run/cli-batch-documentation-delivery-recovery.test.ts)

| Previous test | Decision | Remaining coverage / reason |
| --- | --- | --- |
| Issue List recovery continues after delivery persisted before its maintenance association | Keep | Same owner. |

### [run/cli-batch-documentation.test.ts](../tests/run/cli-batch-documentation.test.ts)

| Previous test | Decision | Remaining coverage / reason |
| --- | --- | --- |
| one documentation occurrence follows each matching successful Batch before later work or parent closure | Keep | Same owner. |
| delivery labels ["docs"] do not match Docs exactly | Remove / merge | near-match delivery labels never trigger documentation. All four invalid labels can coexist: accepting any one incorrectly triggers maintenance and fails the single assertion. |
| delivery labels ["DOCS"] do not match Docs exactly | Remove / merge | near-match delivery labels never trigger documentation. All four invalid labels can coexist: accepting any one incorrectly triggers maintenance and fails the single assertion. |
| delivery labels ["Docs-extra"] do not match Docs exactly | Remove / merge | near-match delivery labels never trigger documentation. All four invalid labels can coexist: accepting any one incorrectly triggers maintenance and fails the single assertion. |
| delivery labels [" Docs "] do not match Docs exactly | Remove / merge | near-match delivery labels never trigger documentation. All four invalid labels can coexist: accepting any one incorrectly triggers maintenance and fails the single assertion. |
| removing the trigger before confirmed delivery prevents maintenance | Keep | Same owner. |
| --issue 51 triggers documentation for its successful Batch | Keep | Same owner. |
| --issue triggers documentation for its successful Batch | Keep | Same owner. |
| unmerged work never triggers documentation | Keep | Same owner. |
| numbered Issue recovery reports no_work immediately when retained work is externally not_planned | Keep | Same owner. |
| numbered Issue recovery reports no_work immediately when retained work is externally completed | Keep | Same owner. |
| work cancelled after merge never triggers documentation | Keep | Same owner. |
| ordinary implementation no_change earns no delivery trigger | Keep | Same owner. |
| a completed occurrence satisfies its restored Batch barrier without another Maintenance Ticket | Remove / merge | cli-batch-documentation: pending documentation recovers before discovery. That scenario already reruns completed maintenance; add document-count and cleanup-count assertions. |
| pending documentation recovers before any parent discovery, using its saved conversation and occurrence | Keep | Same owner. |
| changed configuration ignores the pending occurrence and retains all of its artifacts | Keep | Same owner. |
| Issue List recovery completes maintenance and all 1 configured Issues | Keep | Same owner. |
| Issue List recovery completes maintenance and all 4 configured Issues | Keep | Same owner. |
| committed automatic documentation follows normal publication and integration without ordinary Review | Keep | Same owner. |
| unsuccessful documentation blocks later Batch discovery and parent closure, retaining its artifacts | Keep | Same owner. |
| recovery uses persisted delivery labels after a partial Batch was interrupted | Keep | Same owner. |

### [run/cli-batch-integration.test.ts](../tests/run/cli-batch-integration.test.ts)

| Previous test | Decision | Remaining coverage / reason |
| --- | --- | --- |
| parent holds the CI barrier across out-of-order implementation completion and confirms each merge before starting the next | Keep | Same owner. |
| issue holds the CI barrier across out-of-order implementation completion and confirms each merge before starting the next | Keep | Same owner. |
| one failed required check holds the entire Batch while CI repair is pending | Keep | Same owner. |
| a later rejected merge retains earlier confirmed delivery without rollback or overtaking | Keep | Same owner. |
| a later conflict merge retains earlier confirmed delivery without rollback or overtaking | Keep | Same owner. |

### [run/cli-batch-pause.test.ts](../tests/run/cli-batch-pause.test.ts)

| Previous test | Decision | Remaining coverage / reason |
| --- | --- | --- |
| unsupported Run-level skip keeps sibling mutations gated until cancellation | Keep | Same owner. |
| a non-Agent pause gates sibling operations and dispatch until retry | Keep | Same owner. |
| a pause gates Probe submission in an already-open sibling tab until retry | Keep | Same owner. |
| a non-Agent pause gates sibling operations and dispatch until cancellation | Keep | Same owner. |
| a pause gates Probe submission in an already-open sibling tab until cancellation | Keep | Same owner. |
| a fatal sibling error interrupts unresolved Operator input and retains both executions | Keep | Same owner. |
| a sibling failure closes real Operator input even when the outer signal and stdin remain open | Keep | Same owner. |

### [run/cli-batch-review.test.ts](../tests/run/cli-batch-review.test.ts)

| Previous test | Decision | Remaining coverage / reason |
| --- | --- | --- |
| parent keeps concurrent Reviews isolated when the second Issue completes first | Keep | Same owner. |
| issue keeps concurrent Reviews isolated when the second Issue completes first | Keep | Same owner. |

### [run/cli-batch.test.ts](../tests/run/cli-batch.test.ts)

| Previous test | Decision | Remaining coverage / reason |
| --- | --- | --- |
| parent executes a bounded Batch concurrently with isolated Issue contexts and reversed completion | Keep | Same owner. |
| parent recovery retains Batch membership when a recorded Issue becomes ineligible | Keep | Same owner. |
| issue executes a bounded Batch concurrently with isolated Issue contexts and reversed completion | Keep | Same owner. |
| issue recovery retains Batch membership when a recorded Issue becomes ineligible | Keep | Same owner. |
| a recorded Batch survives cancellation before any Issue checkpoint and cannot be replaced | Keep | Same owner. |
| overlapping parent pages cannot dispatch the same Issue concurrently or consume its Batch slot twice | Keep | Same owner. |
| invalid Batch ownership or membership fails closed before dispatch | Keep | Same owner. |
| a failed Issue cancels a sibling's delayed startup and waits for its resources to be retained | Keep | Same owner. |
| concurrent Git failures serialize non-Agent Operator Pauses before retrying | Keep | Same owner. |
| q at an Operator Pause cancels the Batch before queued questions or retries | Keep | Same owner. |

### [run/cli-cancellation.test.ts](../tests/run/cli-cancellation.test.ts)

| Previous test | Decision | Remaining coverage / reason |
| --- | --- | --- |
| cancellation interrupts unresolved startup without later input or owned resources | Keep | Same owner. |
| cancellation interrupts unresolved Probe retry without later input or owned resources | Keep | Same owner. |
| cancellation interrupts unresolved Probe polling without later input or owned resources | Keep | Same owner. |
| cancellation interrupts unresolved handoff polling without later input or owned resources | Keep | Same owner. |
| cancellation interrupts unresolved correction without later input or owned resources | Keep | Same owner. |
| cancellation interrupts unresolved operation backoff without later input or owned resources | Keep | Same owner. |
| q in a sibling's non-Agent pause cancels startup without waiting for its delay | Keep | Same owner. |
| an explicit matching rerun preserves a cancelled correction's consumed budget and assignment | Keep | Same owner. |
| cancellation after accepted implementation retains completion for a matching rerun | Keep | Same owner. |

### [run/cli-ci-repair-recovery.test.ts](../tests/run/cli-ci-repair-recovery.test.ts)

| Previous test | Decision | Remaining coverage / reason |
| --- | --- | --- |
| missing active ci repair Worktree fails recovery before native dispatch | Keep | Same owner. |
| missing active conflict repair Worktree fails recovery before native dispatch | Keep | Same owner. |
| restarting an unrecoverable repair replaces the whole Issue and retains its old repair resources | Keep | Same owner. |
| completed ci repair rechecks Git evidence before its recovered pending push | Keep | Same owner. |
| completed conflict repair rechecks Git evidence before its recovered pending push | Keep | Same owner. |
| skipping exhausted CI repair retains the Issue resources and lets sibling work continue | Keep | Same owner. |
| blocked repair output is corrected in the same native stage rather than revived as a blocked result | Keep | Same owner. |
| repair Worktree creation interrupted after its side effect reconciles the recorded empty workspace | Keep | Same owner. |
| unexpected remote advancement after repair completion never overwrites remote work | Keep | Same owner. |
| restart preserves an exhausted CI generation until the operator authorizes retry | Keep | Same owner. |
| repair pushes retain the discovery deadline across cancellation and recovery | Keep | Same owner. |
| recovery rejects corrupted repair ownership, pending evidence, and budget before dispatch | Keep | Same owner. |

### [run/cli-ci-repair.test.ts](../tests/run/cli-ci-repair.test.ts)

| Previous test | Decision | Remaining coverage / reason |
| --- | --- | --- |
| a repaired PR integrates its repaired HEAD and recovers queued and delivered checkpoints | Keep | Same owner. |
| failed required checks receive a verified fresh repair on the same PR and remote branch | Keep | Same owner. |
| a second CI repair starts fresh from the first repaired remote head | Keep | Same owner. |
| CI repair never enters ordinary Review, including after matching-input recovery | Keep | Same owner. |
| interrupted CI repair processes missing output by exact native resume and continue | Keep | Same owner. |
| interrupted CI repair processes retained output without a tab | Keep | Same owner. |
| cancellation after accepting a repair retains its consumed count and does not dispatch another attempt | Keep | Same owner. |
| failed Git verification consumes an attempt without pushing false claims or correcting the same repair | Remove / merge | cli-retention: failed and replacement repair executions. Same dirty-first-repair fixture; merge budget, no-correction, push and Probe assertions into retained-resource checks. |
| operator retry rechecks CI before authorizing a fresh two-attempt generation | Keep | Same owner. |
| a repair push with a lost response reconciles its pending evidence without pushing twice | Keep | Same owner. |
| an interrupted repair push resumes from its verified pending evidence | Remove / merge | cli-repair-lookup-recovery: pending ci push transient. Retained scenario has the same interrupted successful push, then a lookup failure and recovery with no duplicate push. |
| two no_change repairs exhaust the independent CI budget and require operator authorization | Remove / merge | cli-ci-repair-recovery: restart preserves exhausted CI generation. Merge consumed count, attempts and no-push assertions into the scenario that also verifies persistent exhaustion. |

### [run/cli-cleanup.test.ts](../tests/run/cli-cleanup.test.ts)

| Previous test | Decision | Remaining coverage / reason |
| --- | --- | --- |
| parent recovery finishes its final child's cleanup before parent closure without a documentation trigger | Keep | Same owner. |
| successful delivery removes only its owned Worktree and assigned final, temporary, and superseded files | Keep | Same owner. |
| Issue cleanup resumes only unfinished actions after a file deletion failure | Keep | Same owner. |
| documentation cleanup resumes only unfinished actions after a file deletion failure | Keep | Same owner. |
| successful cleanup includes Review and fix assignments while findings keep their Review-loop cleanup timing | Keep | Same owner. |
| no-auto-merge retains assigned files and Worktree without successful cleanup | Keep | Same owner. |
| failed retains assigned files and Worktree without successful cleanup | Keep | Same owner. |
| cancelled retains assigned files and Worktree without successful cleanup | Keep | Same owner. |
| incomplete retains assigned files and Worktree without successful cleanup | Keep | Same owner. |
| rejected stage close retains accepted output and cannot earn successful cleanup | Remove / merge | cli-cancellation: cancellation after accepted implementation. Merge resource and same-handle assertions into accepted-stage close failure and recovery. |
| a recovered cleanup rejects another Issue's assigned path before deleting any resources | Keep | Same owner. |
| Issue cancellation after Worktree removal checkpoints that action and recovery only removes unfinished files | Keep | Same owner. |
| documentation cancellation after Worktree removal checkpoints that action and recovery only removes unfinished files | Keep | Same owner. |

### [run/cli-conflict-repair.test.ts](../tests/run/cli-conflict-repair.test.ts)

| Previous test | Decision | Remaining coverage / reason |
| --- | --- | --- |
| explicit merge conflict repairs the existing PR and waits for checks before integrating its verified head | Keep | Same owner. |
| explicit conflicting state starts repair without attempting a rejected merge | Keep | Same owner. |
| two unsuccessful conflict attempts remain exhausted across restart until authorized | Keep | Same owner. |
| operator authorization refreshes merge state and grants only a fresh conflict generation | Keep | Same owner. |
| CI failure after conflict repair consumes the separate CI budget and integrates the latest head | Keep | Same owner. |
| operator resolution after budget exhaustion refreshes checks before another merge request | Keep | Same owner. |
| a queue that reports an explicit conflict hands off to repair instead of waiting for timeout | Keep | Same owner. |
| interrupted conflict repair recovers the exact conversation with continue | Keep | Same owner. |
| interrupted conflict repair recovers existing output without a tab | Keep | Same owner. |
| lost conflict push response reconciles the original remote branch without another push | Keep | Same owner. |
| a repair without target ancestry consumes an attempt and never pushes its false claim | Keep | Same owner. |
| conflict repair preserves the completed ordinary Review across matching recovery | Keep | Same owner. |
| cancellation after a conflict push resumes its pending evidence without pushing again | Remove / merge | cli-repair-lookup-recovery: pending conflict push transient. Same interruption and retained push assertions, with additional lookup recovery. |
| authorized conflict retry waits for explicit mergeability evidence before starting its next generation | Keep | Same owner. |
| recovery rejects corrupted conflict ownership, target ancestry context, and budget before dispatch | Keep | Same owner. |
| conflict evidence appearing during the final merge recheck repairs before issuing a merge request | Keep | Same owner. |
| transient target ancestry inspection retries without consuming another repair attempt | Keep | Same owner. |
| exhausted ancestry observation retries resume through Operator Pause without invalidating the repair | Keep | Same owner. |
| exhausted ancestry observation retries cancel through Operator Pause without invalidating the repair | Keep | Same owner. |

### [run/cli-correction-budget-recovery.test.ts](../tests/run/cli-correction-budget-recovery.test.ts)

| Previous test | Decision | Remaining coverage / reason |
| --- | --- | --- |
| a result arriving during correction backoff is validated before dispatch | Keep | Same owner. |
| a result arriving during correction backoff is validated before dispatch after matching recovery | Keep | Same owner. |
| matching rerun waits only the remaining correction delay and keeps the allocated correction | Keep | Same owner. |
| an invalid retained Review uses only its remaining correction in the original reviewer conversation | Keep | Same owner. |
| operation retries keep their remaining delay and exhausted pause across matching reruns | Keep | Same owner. |
| matching rerun restores a fractional correction delay | Keep | Same owner. |
| matching rerun restores a fractional operation delay | Keep | Same owner. |
| exhausted recovery displays the same manual path before continue and ignores superseded results | Keep | Same owner. |
| cancellation inside operation attempt 1 cannot reclaim that attempt on rerun | Keep | Same owner. |
| cancellation inside operation attempt 2 cannot reclaim that attempt on rerun | Keep | Same owner. |
| recovery rejects invalid retry state {"correctionNotBefore":-1} before dispatch | Keep | Same owner. |
| recovery rejects invalid retry state {"correctionExhausted":true} before dispatch | Keep | Same owner. |
| recovery rejects invalid retry state {"operations":{"inspection":{"consumed":-1,"error":"unavailable"}}} before dispatch | Keep | Same owner. |
| recovery rejects invalid retry state {"operations":{"inspection":{"consumed":1,"error":"unavailable","notBefore":"tomorrow"}}} before dispatch | Keep | Same owner. |

### `run/cli-dependencies.test.ts`

| Previous test | Decision | Remaining coverage / reason |
| --- | --- | --- |
| concurrent fixture PR creation assigns unique numbers after delayed head lookups | Remove / merge | cli-batch-integration: ordered three-PR merge. Complete concurrent Batch tests already require three distinct PR records and correct head associations. |

### [run/cli-documentation-continuation.test.ts](../tests/run/cli-documentation-continuation.test.ts)

| Previous test | Decision | Remaining coverage / reason |
| --- | --- | --- |
| documentation recovery preserves exhausted corrections and its own committed result | Keep | Same owner. |
| documentation recovery preserves exhausted corrections and its own no_change result | Keep | Same owner. |
| changed documentation arguments start new resources without consuming the old checkpoint | Keep | Same owner. |

### [run/cli-documentation-recovery-scope.test.ts](../tests/run/cli-documentation-recovery-scope.test.ts)

| Previous test | Decision | Remaining coverage / reason |
| --- | --- | --- |
| completed documentation from another Run cannot satisfy a Batch closure barrier | Keep | Same owner. |
| restarted automatic documentation keeps its Batch association through another interruption | Keep | Same owner. |

### [run/cli-documentation-recovery.test.ts](../tests/run/cli-documentation-recovery.test.ts)

| Previous test | Decision | Remaining coverage / reason |
| --- | --- | --- |
| cancelled documentation cleanup retries report the retained execution resources | Keep | Same owner. |
| delivered documentation cleanup recovery restores its PR report without replaying delivery | Keep | Same owner. |
| documentation closure with a lost response is reconciled without duplicate writes | Keep | Same owner. |
| interrupted no-change closure resumes from confirmed tracker state without another Agent or closure | Keep | Same owner. |
| cancelled Maintenance Tickets retain documentation artifacts and earn no completion | Keep | Same owner. |
| changed configuration starts separate documentation and retains the interrupted occurrence | Keep | Same owner. |
| documentation output written while stopped is verified without opening another tab | Keep | Same owner. |
| uncertain Maintenance Ticket creation is retained and never automatically repeated or adopted | Keep | Same owner. |
| unrecoverable documentation offers an explicit whole-occurrence restart and retains old resources | Keep | Same owner. |
| skipping documentation retains that occurrence and the next invocation starts new work | Keep | Same owner. |
| a cancelled Maintenance Ticket on recovery reports incomplete without dispatch or cleanup | Remove / merge | cli-documentation-recovery: cancelled Maintenance Tickets. Extend the existing externally cancelled occurrence with a matching rerun. |
| a missing original documentation Worktree offers exit without opening a replacement Agent | Keep | Same owner. |

### [run/cli-documentation.test.ts](../tests/run/cli-documentation.test.ts)

| Previous test | Decision | Remaining coverage / reason |
| --- | --- | --- |
| standalone documentation delivers a Maintenance Ticket without business selection or ordinary Review | Keep | Same owner. |
| verified documentation no_change closes without a PR even with no-auto-merge and code_host closure | Keep | Same owner. |
| a completed documentation Run starts a new maintenance occurrence on the next invocation | Remove / merge | cli-documentation: verified no_change. Extend the existing completed no-change scenario with its second invocation. |
| a missing documentation handoff resumes its own conversation and keeps fixed metadata and paths | Remove / merge | cli-documentation-continuation: exhausted corrections. Both retained outcome cases already remove the active handoff and verify exact resume, metadata, paths and task counts; add no-cleanup-before-resume assertion. |
| a documentation Probe written while stopped is accepted before exact conversation resume | Keep | Same owner. |
| no_change with actual changes is corrected before closure and cleanup | Keep | Same owner. |
| no-auto-merge documentation retains the PR, Worktree, and handoffs without closing | Keep | Same owner. |

### [run/cli-empty-parent.test.ts](../tests/run/cli-empty-parent.test.ts)

| Previous test | Decision | Remaining coverage / reason |
| --- | --- | --- |
| an empty parent returns no_work through the application without closing or dispatching | Keep | Same owner. |
| a failed audit append retries logging without replaying a completed tracker read | Keep | Same owner. |
| pagination cannot hide ineligible children or turn a nonempty parent into no_work | Keep | Same owner. |
| cancelled parents stop discovery without rewriting children | Keep | Same owner. |
| read retries are additional attempts | Remove / merge | cli-operation-recovery: Git fetch retries. Both use the shared operation runner; retained case checks additional-attempt counting, delay reuse and eventual success. |
| exhausted read retries preserve non-Agent Operator Pause and q cancels | Remove / merge | cli-correction-budget-recovery: operation retries keep exhausted pause. Retained case checks attempt count and cancellation across repeated recovery, not only one pause. |
| cancellation during backoff prevents subsequent tracker reads | Remove / merge | cli-cancellation: unresolved operation backoff. Same operation runner; retained case additionally proves cancellation interrupts an unresolved sleep. |

### [run/cli-handoff-corrections.test.ts](../tests/run/cli-handoff-corrections.test.ts)

| Previous test | Decision | Remaining coverage / reason |
| --- | --- | --- |
| execution findings receive a specific correction in the original conversation | Keep | Same owner. |
| additional corrections persist unique assignments, reuse the final seconds delay, and stay exhausted during manual recovery | Keep | Same owner. |
| false Git branch claims receive actionable corrections before acceptance | Keep | Same owner. |
| false Git base claims receive actionable corrections before acceptance | Keep | Same owner. |
| false Git worktree claims receive actionable corrections before acceptance | Keep | Same owner. |
| false Git clean claims receive actionable corrections before acceptance | Keep | Same owner. |
| false Git commits claims receive actionable corrections before acceptance | Keep | Same owner. |
| false Git changed claims receive actionable corrections before acceptance | Keep | Same owner. |

### [run/cli-handoff-observation.test.ts](../tests/run/cli-handoff-observation.test.ts)

| Previous test | Decision | Remaining coverage / reason |
| --- | --- | --- |
| a final published before observation wins over temporary and unrelated files | Keep | Same owner. |
| polling finds an atomic publication without any filesystem notification | Keep | Same owner. |
| partial and same-size manual replacements remain active with colliding modification times | Keep | Same owner. |
| an identical handoff can be resubmitted after correcting independent Git evidence | Keep | Same owner. |
| a superseded final cannot satisfy a correction while its active result is temporary | Keep | Same owner. |
| overwrites during validation and after acceptance cannot change the consumed result | Keep | Same owner. |
| concurrent executions with the same timestamp cannot consume each other's submissions | Keep | Same owner. |

### [run/cli-handoff-recovery.test.ts](../tests/run/cli-handoff-recovery.test.ts)

| Previous test | Decision | Remaining coverage / reason |
| --- | --- | --- |
| restart reprocesses a verified handoff when completion persistence failed | Keep | Same owner. |
| restart after durable completion skips the old stage and starts the next Review | Keep | Same owner. |
| restart ignores a superseded final and an active temporary file until the expected final is published | Keep | Same owner. |

### [run/cli-implementation-lifecycle.test.ts](../tests/run/cli-implementation-lifecycle.test.ts)

| Previous test | Decision | Remaining coverage / reason |
| --- | --- | --- |
| configured commands and prompts use canonical LF while preserving literal Unicode and quotes | Keep | Same owner. |
| independent handles can complete while another handle's command transport is pending | Keep | Same owner. |
| a transient close failure retries the same owned handle after the operation delay | Keep | Same owner. |
| exhausted close retries enter ordinary Operator Pause and q retains the accepted checkpoint | Remove / merge | cli-cancellation: cancellation after accepted implementation. Merge retry count and pause assertions into the scenario that also resumes the accepted checkpoint. |
| operator-authorized close retry never repeats the accepted implementation | Keep | Same owner. |
| standalone selection prevents dispatch for not_ready | Keep | Same owner. |
| standalone selection prevents dispatch for foreign_owner | Keep | Same owner. |
| standalone selection prevents dispatch for partial | Keep | Same owner. |
| standalone selection prevents dispatch for unrecorded | Keep | Same owner. |
| standalone selection prevents dispatch for blocked | Keep | Same owner. |

### [run/cli-implementation-probe.test.ts](../tests/run/cli-implementation-probe.test.ts)

| Previous test | Decision | Remaining coverage / reason |
| --- | --- | --- |
| Probe output contains only discovered identity and metadata | Keep | Same owner. |
| superseded Probe output cannot satisfy the active path | Keep | Same owner. |
| invalid Probes use their persisted operation budget and fresh assignments before implementation | Keep | Same owner. |
| exhausted Probe corrections keep the active path available for manual publication | Keep | Same owner. |
| missing Probe output never consumes retries or injects reminders | Keep | Same owner. |
| cancelling Probe backoff keeps consumed retry evidence and sends no correction | Remove / merge | cli-cancellation: unresolved Probe retry. Same cancellation boundary; merge superseded-path and native-identity assertions. |

### [run/cli-implementation-resume.test.ts](../tests/run/cli-implementation-resume.test.ts)

| Previous test | Decision | Remaining coverage / reason |
| --- | --- | --- |
| missing original Worktree offers only restart or exit before creating replacement work | Keep | Same owner. |
| a retained implementation resumes only its saved role with literal all-occurrence session substitution | Keep | Same owner. |
| missing output resumes with continue even after correction capacity is exhausted | Keep | Same owner. |
| cancellation during recovered startup prevents the delayed continue | Keep | Same owner. |
| a durably completed implementation is verified without dispatching another native stage | Remove / merge | cli-handoff-observation: overwrites during validation and after acceptance. Retained test reruns completed work with a corrupted old handoff and verifies accepted evidence is unchanged. |
| a valid result produced while Runner was stopped completes without opening a native tab | Remove / merge | adapters/cli-implementation-git: dirty-cancel. Real Git case publishes while stopped, forbids create/submit/close, and checks invocation, metadata and actual push. |
| invalid retained output resumes only for correction and keeps its implementation assignment | Keep | Same owner. |
| exhausted retained output can be corrected manually without reopening a native tab | Keep | Same owner. |
| a consumed nonzero correction budget stays exhausted across restart and invalid manual writes | Keep | Same owner. |

### [run/cli-implementation-validation.test.ts](../tests/run/cli-implementation-validation.test.ts)

| Previous test | Decision | Remaining coverage / reason |
| --- | --- | --- |
| unexpected Probe fields cannot establish identity or dispatch implementation | Keep | Same owner. |
| Probe rejects invalid run_id before task submission | Remove / merge | unexpected Probe fields; cli-implementation-probe: invalid Probes budget. Extra ownership keys use one exact-key-set rule; invalid native identity is already repeated before successful correction. |
| Probe rejects invalid role before task submission | Remove / merge | unexpected Probe fields; cli-implementation-probe: invalid Probes budget. Extra ownership keys use one exact-key-set rule; invalid native identity is already repeated before successful correction. |
| Probe rejects invalid sessionid before task submission | Remove / merge | unexpected Probe fields; cli-implementation-probe: invalid Probes budget. Extra ownership keys use one exact-key-set rule; invalid native identity is already repeated before successful correction. |
| Probe rejects invalid pr_title before task submission | Keep | Same owner. |
| Probe rejects invalid pr_body before task submission | Keep | Same owner. |
| temporary output and missing final output keep the native conversation incomplete without reminders | Remove / merge | cli-handoff-observation: polling finds an atomic publication; cli-cancellation: handoff polling. Polling scenario already checks incomplete state and no extra submissions until atomic publication; cancellation matrix checks temporary configuration removal. |
| after correction capacity is exhausted a manual overwrite can complete the current invocation | Remove / merge | cli-handoff-observation: partial and same-size manual replacements. Both use agentRetry=0 and manual writes; retained case also exercises malformed and same-size content. |

### [run/cli-implementation.test.ts](../tests/run/cli-implementation.test.ts)

| Previous test | Decision | Remaining coverage / reason |
| --- | --- | --- |
| one standalone implementation persists verified completion before closing its tab, without delivering the Issue | Keep | Same owner. |

### [run/cli-integration.test.ts](../tests/run/cli-integration.test.ts)

| Previous test | Decision | Remaining coverage / reason |
| --- | --- | --- |
| delivery requires confirmed squash integration and completed tracker state, capturing exact labels | Keep | Same owner. |
| queue admission receives no delivery credit before the configured merge confirmation timeout | Keep | Same owner. |
| a queued squash is observed as merged before runner closure, including admin policy | Keep | Same owner. |
| code_host closure observes the source 10-second and 30-second waits without a tracker write | Remove / merge | cli-integration: code_host closure remains open. Retained scenario checks the same first waits and zero tracker writes, then an authorized observation retry. |
| not_planned after merge earns no delivery credit | Keep | Same owner. |
| reservation after merge earns no delivery credit | Keep | Same owner. |
| a lost merge response reconciles observed completion without replaying the write | Keep | Same owner. |
| a lost closure response reconciles observed completion without replaying the write | Keep | Same owner. |
| an acknowledged tracker write still needs observed closed/completed state | Keep | Same owner. |
| non-conflict rejection retains the original error and cannot trigger delivery | Keep | Same owner. |
| recovery after a confirmed merge skips Agent and merge work and finishes tracker confirmation | Keep | Same owner. |
| cancellation during queue polling retains merge evidence and prevents closure | Remove / merge | cli-integration: interrupted queue resumes. Merge pending phase and no-closure assertions into the interruption/recovery scenario. |
| recovery cannot credit delivery when recorded publication differs from verified commits | Keep | Same owner. |
| a changed observed HEAD pauses without merging or closing the Issue | Keep | Same owner. |
| code_host closure that remains open pauses and observes again without issuing tracker writes | Keep | Same owner. |
| an interrupted queue resumes its existing request and deadline without another Agent or merge request | Keep | Same owner. |

### [run/cli-issue-list.test.ts](../tests/run/cli-issue-list.test.ts)

| Previous test | Decision | Remaining coverage / reason |
| --- | --- | --- |
| an explicit Issue List dispatches only selected Issues in ascending order up to the Batch size without parent discovery | Keep | Same owner. |
| list discovery filters blocked, externally owned, unready and reserved work before filling the Batch | Keep | Same owner. |
| a list of completed and cancelled Issues reports no_work without delivery mutations | Keep | Same owner. |
| a matching all-terminal Issue List reports no_work while retaining its recorded Batch | Keep | Same owner. |
| unready open list Issues report incomplete rather than no_work | Keep | Same owner. |
| a numbered standalone Issue overrides the configured list | Keep | Same owner. |
| list option ordering preserves the configured Target Branch | Keep | Same owner. |
| empty and invalid lists fail at startup before external reads or delivery resources | Keep | Same owner. |
| a list with a missing Issue cannot dispatch earlier eligible work from an incomplete discovery | Keep | Same owner. |
| an incomplete blocker read fails closed before any list Reservation | Keep | Same owner. |
| list discovery rejects unexpected Issue identity or unsupported terminal state before Reservation | Keep | Same owner. |
| list recovery preserves recorded ownership and verified completion without redispatch or adopting residual Reservations | Keep | Same owner. |
| cancellation during a list assignment retains its Batch and handoff evidence without dispatching replacements | Keep | Same owner. |
| a verified no_change list implementation remains incomplete and retains its checkpoint | Remove / merge | cli-batch-documentation: ordinary no_change; cli-reporting: ordinary no_change. Shared standalone no-change policy is already checked for checkpoint, report and absence of Batch delivery credit. |

### [run/cli-operation-recovery.test.ts](../tests/run/cli-operation-recovery.test.ts)

| Previous test | Decision | Remaining coverage / reason |
| --- | --- | --- |
| audit creation rejects skip and success claims before q cancels without delivery effects | Keep | Same owner. |
| audit creation rejects skip and success claims before EOF cancels without delivery effects | Keep | Same owner. |
| Git fetch reuses the final seconds-based delay and requires Enter after exhausting additional retries | Keep | Same owner. |
| Reservation write reuses the final seconds-based delay and requires Enter after exhausting additional retries | Keep | Same owner. |
| a rejected substantive prompt is audited without replay, redirection, or Operator Pause | Keep | Same owner. |
| cancelling unresolved createTab stops the Run without waiting for the I/O bound | Keep | Same owner. |
| cancelling unresolved submitText stops the Run without waiting for the I/O bound | Keep | Same owner. |
| cancelling unresolved closeTab stops the Run without waiting for the I/O bound | Keep | Same owner. |
| audit recovery cannot replay a completed Reservation or accept a logging gap | Keep | Same owner. |
| audit recovery cannot replay a completed Worktree or accept a logging gap | Keep | Same owner. |
| audit recovery cannot replay a completed Runner Tab or accept a logging gap | Keep | Same owner. |
| audit recovery cannot replay a completed prompt or accept a logging gap | Keep | Same owner. |
| audit recovery cannot replay a completed close or accept a logging gap | Keep | Same owner. |
| a lost addLabel response is reconciled immediately even with no automatic retries | Keep | Same owner. |
| a lost addAssignee response is reconciled immediately even with no automatic retries | Keep | Same owner. |
| an unresolved terminal createTab has a finite bound and retains partial-operation diagnostics | Keep | Same owner. |
| an unresolved terminal submitText has a finite bound and retains partial-operation diagnostics | Keep | Same owner. |
| an unresolved terminal closeTab has a finite bound and retains partial-operation diagnostics | Keep | Same owner. |
| failed tab creation pauses before an explicitly authorized new resource attempt | Keep | Same owner. |
| skipping a non-Agent Issue failure retains its Reservation and lets its sibling finish | Keep | Same owner. |
| Worktree creation requires manual retry without spending the automatic budget | Keep | Same owner. |

### [run/cli-parent-completion.test.ts](../tests/run/cli-parent-completion.test.ts)

| Previous test | Decision | Remaining coverage / reason |
| --- | --- | --- |
| an all-cancelled parent closes only after completed tracker state is observed | Keep | Same owner. |
| a cancelled Batch member permits its ready sibling to integrate | Keep | Same owner. |
| a cancelled Batch member permits its ready sibling to integrate after matching recovery | Keep | Same owner. |
| a cancelled Batch member does not let an unfinished member bypass the integration barrier | Keep | Same owner. |
| each successive bounded Batch fetches the current Target Branch | Keep | Same owner. |
| unresolved child {"labels":[]} prevents closure after a successful Batch | Keep | Same owner. |
| unresolved child {"assignees":["developer"]} prevents closure after a successful Batch | Keep | Same owner. |
| unresolved child {"labels":["ready-for-agent","sandcastle:reserved"]} prevents closure after a successful Batch | Keep | Same owner. |
| an unresolved child outside issueList prevents parent closure | Keep | Same owner. |
| a new child in the final closure scan keeps the parent open | Keep | Same owner. |
| a child cancelled between scans permits parent closure in the same Run | Keep | Same owner. |
| a lost parent closure response reconciles without repeating the write or child work | Keep | Same owner. |
| an unconfirmed parent closure pauses and a matching rerun retains completed child evidence | Keep | Same owner. |
| matching recovery continues a partially integrated Batch without replaying delivered children | Keep | Same owner. |
| parent cancellation during closure backoff stops retries without changing its children | Keep | Same owner. |
| a delivered child reopened during parent closure stays incomplete without replaying its completed work | Keep | Same owner. |
| parent completed after a Batch stops further dispatch without rewriting children | Keep | Same owner. |
| parent not_planned after a Batch stops further dispatch without rewriting children | Keep | Same owner. |
| parent rescans after a Batch and delivers a newly unblocked child before closure | Keep | Same owner. |

### [run/cli-parent-pending-dispatch.test.ts](../tests/run/cli-parent-pending-dispatch.test.ts)

| Previous test | Decision | Remaining coverage / reason |
| --- | --- | --- |
| a withheld initial assignment is submitted in its original conversation when eligibility returns | Keep | Same owner. |
| a withheld correction retains its prompt, path and spent budget until eligibility returns | Keep | Same owner. |
| cancellation inside the dispatch gate retains the known unsent assignment for recovery | Keep | Same owner. |
| valid output at a pending assignment completes without reopening its conversation | Keep | Same owner. |
| a transport attempt is not replayed as a known unsent assignment after interruption | Keep | Same owner. |
| malformed pending prompt evidence fails recovery before another Agent submission | Keep | Same owner. |

### [run/cli-parent-revalidation.test.ts](../tests/run/cli-parent-revalidation.test.ts)

| Previous test | Decision | Remaining coverage / reason |
| --- | --- | --- |
| parent cancellation during Git setup prevents substantive Agent dispatch | Keep | Same owner. |
| parent cancellation after a failed assignee write prevents its retry mutation | Keep | Same owner. |
| eligibility becoming cancelled during the Probe prevents implementation dispatch | Keep | Same owner. |
| eligibility becoming left_scope during the Probe prevents implementation dispatch | Keep | Same owner. |
| eligibility becoming external during the Probe prevents implementation dispatch | Keep | Same owner. |
| eligibility becoming blocked during the Probe prevents implementation dispatch | Keep | Same owner. |
| eligibility becoming not_ready during the Probe prevents implementation dispatch | Keep | Same owner. |
| eligibility becoming reservation_label during the Probe prevents implementation dispatch | Keep | Same owner. |
| eligibility becoming runner during the Probe prevents implementation dispatch | Keep | Same owner. |
| eligibility becoming closed during the Probe prevents implementation dispatch | Keep | Same owner. |
| parent cancellation during native startup prevents implementation dispatch | Keep | Same owner. |
| addLabel retry stops when eligibility becomes cancelled during backoff | Keep | Same owner. |
| addLabel retry stops when eligibility becomes external during backoff | Remove / merge | eligibility becoming change during Probe; retained cancelled/reservation cases for both writers. Both writers call the same inspect() before mutation. Keep each writer-specific Reservation rule and cancellation; enumerate eligibility reasons once. |
| addLabel retry stops when eligibility becomes blocked during backoff | Remove / merge | eligibility becoming change during Probe; retained cancelled/reservation cases for both writers. Both writers call the same inspect() before mutation. Keep each writer-specific Reservation rule and cancellation; enumerate eligibility reasons once. |
| addLabel retry stops when eligibility becomes left_scope during backoff | Remove / merge | eligibility becoming change during Probe; retained cancelled/reservation cases for both writers. Both writers call the same inspect() before mutation. Keep each writer-specific Reservation rule and cancellation; enumerate eligibility reasons once. |
| addLabel retry stops when eligibility becomes not_ready during backoff | Remove / merge | eligibility becoming change during Probe; retained cancelled/reservation cases for both writers. Both writers call the same inspect() before mutation. Keep each writer-specific Reservation rule and cancellation; enumerate eligibility reasons once. |
| addLabel retry stops when eligibility becomes reservation during backoff | Keep | Same owner. |
| addAssignee retry stops when eligibility becomes cancelled during backoff | Keep | Same owner. |
| addAssignee retry stops when eligibility becomes external during backoff | Remove / merge | eligibility becoming change during Probe; retained cancelled/reservation cases for both writers. Both writers call the same inspect() before mutation. Keep each writer-specific Reservation rule and cancellation; enumerate eligibility reasons once. |
| addAssignee retry stops when eligibility becomes blocked during backoff | Remove / merge | eligibility becoming change during Probe; retained cancelled/reservation cases for both writers. Both writers call the same inspect() before mutation. Keep each writer-specific Reservation rule and cancellation; enumerate eligibility reasons once. |
| addAssignee retry stops when eligibility becomes left_scope during backoff | Remove / merge | eligibility becoming change during Probe; retained cancelled/reservation cases for both writers. Both writers call the same inspect() before mutation. Keep each writer-specific Reservation rule and cancellation; enumerate eligibility reasons once. |
| addAssignee retry stops when eligibility becomes not_ready during backoff | Remove / merge | eligibility becoming change during Probe; retained cancelled/reservation cases for both writers. Both writers call the same inspect() before mutation. Keep each writer-specific Reservation rule and cancellation; enumerate eligibility reasons once. |
| addAssignee retry stops when eligibility becomes reservation during backoff | Keep | Same owner. |
| a lost assignee response reconciles the complete Reservation without repeating the write | Remove / merge | cli-operation-recovery: lost addAssignee response. Same shared Reservation writer, with stronger zero-retry assertions. |
| parent cancellation during correction backoff prevents the follow-up prompt | Keep | Same owner. |
| parent cancellation during recovery startup prevents continue in the retained conversation | Keep | Same owner. |

### [run/cli-parent-selection.test.ts](../tests/run/cli-parent-selection.test.ts)

| Previous test | Decision | Remaining coverage / reason |
| --- | --- | --- |
| parent dispatches the lowest eligible direct children up to the configured Batch size | Remove / merge | cli-parent-selection: reads every child and blocker page. Larger discovery scenario also selects exactly the lowest eligible pair and checks exact Reservation mutations. |
| parent reads every child and blocker page before selecting across labels, ownership and Issue List filtering | Keep | Same owner. |
| parent cancellation after a partial Reservation prevents assignment and dispatch | Keep | Same owner. |
| a lost Reservation label prevents creating a partial assignee Reservation | Keep | Same owner. |
| matching parent progress continues only recorded Reservations among unrelated residual markers | Keep | Same owner. |
| changed configuration never adopts parent Reservations from a different input hash | Keep | Same owner. |
| failed assignee writes retain a partial Reservation without automatic compensation or later adoption | Keep | Same owner. |
| a lost write response is reconciled before retrying the same Reservation mutation | Remove / merge | cli-operation-recovery: lost addLabel response. Same shared Reservation writer; retained test additionally verifies no automatic retries or Operator Pause. |
| parent stops dispatch and retains Reservation markers when a reserved child becomes left_scope | Remove / merge | cli-parent-revalidation: eligibility during Probe; lost readiness after Reservation. Use the complete eligibility matrix once and retain a pre-Git post-Reservation gate check. |
| parent stops dispatch and retains Reservation markers when a reserved child becomes external | Remove / merge | cli-parent-revalidation: eligibility during Probe; lost readiness after Reservation. Use the complete eligibility matrix once and retain a pre-Git post-Reservation gate check. |
| parent stops dispatch and retains Reservation markers when a reserved child becomes blocked | Remove / merge | cli-parent-revalidation: eligibility during Probe; lost readiness after Reservation. Use the complete eligibility matrix once and retain a pre-Git post-Reservation gate check. |
| parent stops dispatch and retains Reservation markers when a reserved child becomes not_ready | Remove / merge | cli-parent-revalidation: eligibility during Probe; lost readiness after Reservation. Use the complete eligibility matrix once and retain a pre-Git post-Reservation gate check. |
| parent stops dispatch and retains Reservation markers when a reserved child becomes closed | Remove / merge | cli-parent-revalidation: eligibility during Probe; lost readiness after Reservation. Use the complete eligibility matrix once and retain a pre-Git post-Reservation gate check. |
| a blocker-page failure after an open blocker cannot permit selection | Keep | Same owner. |
| invalid parent discovery fails before Reservation: foreign_child | Keep | Same owner. |
| invalid parent discovery fails before Reservation: child_page_cycle | Keep | Same owner. |
| invalid parent discovery fails before Reservation: blocker_page_cycle | Keep | Same owner. |
| invalid parent discovery fails before Reservation: blocker_closure | Keep | Same owner. |
| invalid parent discovery fails before Reservation: child_closure | Keep | Same owner. |
| a parent consumes retained handoff evidence for its recorded execution after interruption | Keep | Same owner. |
| cancellation after one child completes prevents subsequent Batch dispatch | Keep | Same owner. |

### [run/cli-prompt-assembly.test.ts](../tests/run/cli-prompt-assembly.test.ts)

| Previous test | Decision | Remaining coverage / reason |
| --- | --- | --- |
| prompt assembly preserves literal context, separate submissions and waits | Keep | Same owner. |
| retained prompt assignments resume with only continue after startup | Keep | Same owner. |

### [run/cli-publication-merged-repair.test.ts](../tests/run/cli-publication-merged-repair.test.ts)

| Previous test | Decision | Remaining coverage / reason |
| --- | --- | --- |
| an exact merged PR stops recovery after an interrupted ci repair assignment without continuation or another push | Keep | Same owner. |
| an exact merged PR stops recovery after an interrupted ci repair push without continuation or another push | Keep | Same owner. |
| an exact merged PR stops recovery after an interrupted conflict repair assignment without continuation or another push | Keep | Same owner. |
| an exact merged PR stops recovery after an interrupted conflict repair push without continuation or another push | Keep | Same owner. |
| a merge observed during discovery stops check polling and repair writes at the merged head | Keep | Same owner. |
| a merge observed during repair_push stops check polling and repair writes at the merged head | Keep | Same owner. |

### [run/cli-publication-pause.test.ts](../tests/run/cli-publication-pause.test.ts)

| Previous test | Decision | Remaining coverage / reason |
| --- | --- | --- |
| a sibling pause before PR dispatch requires Enter before creation | Keep | Same owner. |
| a sibling pause before PR dispatch requires q to cancel creation | Keep | Same owner. |
| a sibling pause before PR dispatch requires EOF to cancel creation | Keep | Same owner. |

### [run/cli-publication-recovery.test.ts](../tests/run/cli-publication-recovery.test.ts)

| Previous test | Decision | Remaining coverage / reason |
| --- | --- | --- |
| restart after publication intent continues the recorded delivery without replaying confirmed effects | Keep | Same owner. |
| restart after publication push continues the recorded delivery without replaying confirmed effects | Keep | Same owner. |
| restart after publication pushed continues the recorded delivery without replaying confirmed effects | Keep | Same owner. |
| restart after publication creation continues the recorded delivery without replaying confirmed effects | Keep | Same owner. |
| restart after publication observation continues the recorded delivery without replaying confirmed effects | Keep | Same owner. |
| restart pauses before retrying an uncertain PR creation with no exact remote match | Keep | Same owner. |
| restart pauses on advanced remote evidence without replacing the recorded publication | Keep | Same owner. |
| restart pauses on absent remote evidence without replacing the recorded publication | Keep | Same owner. |
| restart pauses on number remote evidence without replacing the recorded publication | Keep | Same owner. |
| restart pauses on url remote evidence without replacing the recorded publication | Keep | Same owner. |
| restart pauses on duplicate remote evidence without replacing the recorded publication | Keep | Same owner. |
| restart pauses on closed remote evidence without replacing the recorded publication | Keep | Same owner. |
| restart pauses on draft remote evidence without replacing the recorded publication | Keep | Same owner. |
| restart pauses on missing remote evidence without replacing the recorded publication | Keep | Same owner. |
| restart adopts an exact merged PR with runner closure without repeating Agent or publication work | Keep | Same owner. |
| restart adopts an exact merged PR with code_host closure without repeating Agent or publication work | Keep | Same owner. |
| restart adopts an exact merged PR with no_auto_merge closure without repeating Agent or publication work | Keep | Same owner. |
| a completed tracker Issue with unmerged merge evidence cannot earn delivery credit on restart | Keep | Same owner. |
| a completed tracker Issue with head merge evidence cannot earn delivery credit on restart | Keep | Same owner. |
| a completed tracker Issue with advanced merge evidence cannot earn delivery credit on restart | Keep | Same owner. |
| a completed tracker Issue with identity merge evidence cannot earn delivery credit on restart | Keep | Same owner. |

### [run/cli-publication.test.ts](../tests/run/cli-publication.test.ts)

| Previous test | Decision | Remaining coverage / reason |
| --- | --- | --- |
| no-auto-merge publishes fixed Probe metadata, waits for checks, and retains unmerged resources without delivery credit | Keep | Same owner. |
| a lost push response reconciles recorded evidence without repeating the completed write | Keep | Same owner. |
| a lost create response reconciles recorded evidence without repeating the completed write | Keep | Same owner. |
| uncertain PR creation with no exact match requires operator authorization before a second create | Keep | Same owner. |
| a branch PR mismatch pauses without creating a replacement | Keep | Same owner. |
| a targetBranch PR mismatch pauses without creating a replacement | Keep | Same owner. |
| a headSha PR mismatch pauses without creating a replacement | Keep | Same owner. |
| a duplicate PR mismatch pauses without creating a replacement | Keep | Same owner. |
| a closed PR mismatch pauses without creating a replacement | Keep | Same owner. |
| a draft PR mismatch pauses without creating a replacement | Keep | Same owner. |
| remote advancement after an uncertain push is retained without a second push or PR | Keep | Same owner. |
| changed local work after the completed tab closes cannot be pushed | Keep | Same owner. |
| required checks wait 30 seconds for discovery, then poll pending checks until all pass | Keep | Same owner. |
| required-check timeout uses configured minutes and operator retry without another creation | Keep | Same owner. |
| fail checks retain their evidence when cancellation stops repair startup | Keep | Same owner. |
| cancel checks retain their evidence when cancellation stops repair startup | Keep | Same owner. |
| cancellation during discovery delay retains PR identity and prevents check discovery | Keep | Same owner. |
| lost Issue eligibility after push stops publication without a PR or an Operator Pause | Keep | Same owner. |
| an audit failure after PR creation retries only the log append | Keep | Same owner. |
| an existing remote head cannot be adopted without recorded publication intent | Keep | Same owner. |

### [run/cli-recovery-restart.test.ts](../tests/run/cli-recovery-restart.test.ts)

| Previous test | Decision | Remaining coverage / reason |
| --- | --- | --- |
| explicit whole-Issue restart retains failed resources and resets only the new execution | Keep | Same owner. |
| an explicit native resume failure offers restart or exit without inferring Agent liveness | Keep | Same owner. |
| a missing retained conflict repair Worktree offers exit even during deferred integration | Keep | Same owner. |
| restarting an Issue with missing implementation identity preserves another Issue's completed progress and consumed counts | Keep | Same owner. |
| restarting an Issue with missing reviewer identity preserves another Issue's completed progress and consumed counts | Keep | Same owner. |
| restarting an Issue with missing findings preserves another Issue's completed progress and consumed counts | Keep | Same owner. |
| EOF at the recovery choice retains the failed execution without restarting | Keep | Same owner. |
| cancellation at the recovery choice retains the failed execution without restarting | Keep | Same owner. |
| cancellation during replacement inspection preserves matching-input recovery | Keep | Same owner. |
| cancellation during replacement base fetch preserves matching-input recovery | Keep | Same owner. |

### [run/cli-recovery-scope.test.ts](../tests/run/cli-recovery-scope.test.ts)

| Previous test | Decision | Remaining coverage / reason |
| --- | --- | --- |
| the recovery hash uses the configuration bytes validated at startup | Keep | Same owner. |
| an execution checkpoint from another input scope cannot resume or overwrite retained work | Keep | Same owner. |
| changed arguments ignore old counts and preserve ambiguous retained work | Keep | Same owner. |
| changed configuration ignore old counts and preserve ambiguous retained work | Keep | Same owner. |
| a failed atomic checkpoint write preserves the last valid invocation without serializing tab handles | Keep | Same owner. |
| standalone documentation retains Run arguments on its occurrence and execution | Keep | Same owner. |

### [run/cli-repair-budget-recovery.test.ts](../tests/run/cli-repair-budget-recovery.test.ts)

| Previous test | Decision | Remaining coverage / reason |
| --- | --- | --- |
| conflict-to-CI recovery preserves separate exhausted budgets until category-specific authorization | Keep | Same owner. |

### [run/cli-repair-lookup-recovery.test.ts](../tests/run/cli-repair-lookup-recovery.test.ts)

| Previous test | Decision | Remaining coverage / reason |
| --- | --- | --- |
| pending ci repair push lookup supports transient recovery without repeating the push | Keep | Same owner. |
| pending ci repair push lookup supports retry recovery without repeating the push | Keep | Same owner. |
| pending ci repair push lookup supports cancel recovery without repeating the push | Keep | Same owner. |
| pending conflict repair push lookup supports transient recovery without repeating the push | Keep | Same owner. |
| pending conflict repair push lookup supports retry recovery without repeating the push | Keep | Same owner. |
| pending conflict repair push lookup supports cancel recovery without repeating the push | Keep | Same owner. |

### [run/cli-repair-probe-recovery.test.ts](../tests/run/cli-repair-probe-recovery.test.ts)

| Previous test | Decision | Remaining coverage / reason |
| --- | --- | --- |
| interrupted ci repair Probe restores retained native identity before dispatch | Keep | Same owner. |
| missing interrupted ci repair identity offers whole-Issue restart or exit | Keep | Same owner. |
| invalid interrupted ci repair identity offers whole-Issue restart or exit | Keep | Same owner. |
| directory interrupted ci repair identity offers whole-Issue restart or exit | Keep | Same owner. |
| interrupted conflict repair Probe restores retained native identity before dispatch | Keep | Same owner. |
| missing interrupted conflict repair identity offers whole-Issue restart or exit | Keep | Same owner. |
| invalid interrupted conflict repair identity offers whole-Issue restart or exit | Keep | Same owner. |
| directory interrupted conflict repair identity offers whole-Issue restart or exit | Keep | Same owner. |

### [run/cli-reporting.test.ts](../tests/run/cli-reporting.test.ts)

| Previous test | Decision | Remaining coverage / reason |
| --- | --- | --- |
| an empty Run reports no native conversation and a parsed workflow outcome | Remove / merge | cli-empty-parent: empty parent. Merge native-session and parsed audit assertions into the existing empty Run. |
| reports keep selection order when native implementations finish in reverse order | Keep | Same owner. |
| failed preserves structured reports, target branch, and retained resources | Keep | Same owner. |
| cancelled preserves structured reports, target branch, and retained resources | Keep | Same owner. |
| confirmed merge and completed tracker state earn successful delivery credit | Remove / merge | cli-integration: confirmed squash integration. Merge structured completed status into the existing successful delivery scenario. |
| documentation no_change is reported after closure with no retained Worktree | Remove / merge | cli-documentation: verified no_change. Merge structured maintenance status and retained-resource assertions. |
| workflow audit errors redact credentials without recording task or Agent output | Keep | Same owner. |
| a CI-ready unmerged PR has a structured report without successful delivery credit | Keep | Same owner. |
| releasing a Reservation after the handoff does not report successful delivery | Keep | Same owner. |
| an ordinary no_change handoff reports no delivery credit | Keep | Same owner. |
| progress identifies pending Probes, native identity, and each current absolute correction path | Keep | Same owner. |
| resumed work displays its saved identity and active handoff before continuing | Remove / merge | cli-implementation-resume: retained implementation. Merge progress assertion immediately before continue in the existing resume test. |
| cancelling the final audit write retains completed ticket evidence without replaying delivery | Keep | Same owner. |

### [run/cli-retention.test.ts](../tests/run/cli-retention.test.ts)

| Previous test | Decision | Remaining coverage / reason |
| --- | --- | --- |
| cancellation reports and retains original working changes, partial files and superseded handoffs | Keep | Same owner. |
| changed arguments retains old artifacts without adopting the existing Reservation | Keep | Same owner. |
| changed configuration retains old artifacts without adopting the existing Reservation | Keep | Same owner. |
| abrupt process loss leaves its original working changes and durable execution evidence | Keep | Same owner. |
| a failed execution reports its resources without deleting diagnostic files | Keep | Same owner. |
| no-auto-merge retains and reports failed and replacement repair executions on the original PR | Keep | Same owner. |
| cancellation during a Review fix retains and reports necessary findings and both role assignments | Keep | Same owner. |
| cancelled documentation reports its Maintenance Ticket checkpoint and execution artifacts | Keep | Same owner. |

### [run/cli-review-recovery.test.ts](../tests/run/cli-review-recovery.test.ts)

| Previous test | Decision | Remaining coverage / reason |
| --- | --- | --- |
| an invalid retained review result corrects in the original role without gaining a Review round | Keep | Same owner. |
| an invalid retained fix result corrects in the original role without gaining a Review round | Keep | Same owner. |
| a required missing findings report offers explicit recovery failure before resuming the fix | Keep | Same owner. |
| a required empty findings report offers explicit recovery failure before resuming the fix | Keep | Same owner. |
| a completed review checkpoint skips its Agent work and preserves the final-round fix | Keep | Same owner. |
| a completed fix checkpoint skips its Agent work and preserves the final-round fix | Keep | Same owner. |

### [run/cli-review-resume.test.ts](../tests/run/cli-review-resume.test.ts)

| Previous test | Decision | Remaining coverage / reason |
| --- | --- | --- |
| an interrupted fix retains findings and uncommitted work and resumes only the exact implementation conversation | Remove / merge | adapters/cli-review-git. Real Git scenario verifies retained staged edits, exact resume/continue, role and invocation preservation, accumulated commits and findings cleanup. |
| an interrupted later Review resumes the original reviewer with its preserved incremental base | Keep | Same owner. |
| a review result published while stopped completes without opening a native tab | Keep | Same owner. |
| a fix result published while stopped completes without opening a native tab | Keep | Same owner. |
| a completed Review/fix checkpoint revalidates all accumulated commits without redispatch | Remove / merge | cli-review: cap=1 final findings. Merge successful rerun assertion into the scenario that already establishes completed Review/fix evidence. |
| a persisted passed Review with dirty evidence cannot restore publication eligibility | Keep | Same owner. |
| a persisted passed Review with wrong branch evidence cannot restore publication eligibility | Keep | Same owner. |
| an invalid retained reviewer identity is rejected before native dispatch | Keep | Same owner. |
| an invalid retained findings ownership is rejected before native dispatch | Keep | Same owner. |
| an invalid retained Review base is rejected before native dispatch | Keep | Same owner. |
| an invalid retained fix budget is rejected before native dispatch | Keep | Same owner. |
| Review correction exhaustion survives restart and accepts manual overwrite without opening a tab | Keep | Same owner. |
| a withheld Review assignment retains its invocation and resumes only its reviewer when eligibility returns | Keep | Same owner. |
| cancellation during review startup prevents its first prompt and retains context | Keep | Same owner. |
| cancellation during fix startup prevents its first prompt and retains context | Keep | Same owner. |
| failed findings cleanup retains the completed checkpoint and retries cleanup without replaying stages | Keep | Same owner. |

### [run/cli-review-validation.test.ts](../tests/run/cli-review-validation.test.ts)

| Previous test | Decision | Remaining coverage / reason |
| --- | --- | --- |
| Review rejects wrong findings path and corrects in the same round and conversation | Keep | Same owner. |
| Review rejects missing report and corrects in the same round and conversation | Keep | Same owner. |
| Review rejects empty report and corrects in the same round and conversation | Keep | Same owner. |
| Review rejects directory report and corrects in the same round and conversation | Keep | Same owner. |
| Review rejects dirty Worktree and corrects in the same round and conversation | Keep | Same owner. |
| Review rejects reviewer commit and corrects in the same round and conversation | Keep | Same owner. |
| reviewer Probe rejects PR metadata without spending a Review round or correction budget | Keep | Same owner. |
| reviewer Probe rejects generated identity without spending a Review round or correction budget | Keep | Same owner. |
| reviewer Probe rejects wrong ownership without spending a Review round or correction budget | Keep | Same owner. |
| no_change cannot satisfy findings; the correction remains in the fix conversation without another Review | Keep | Same owner. |
| a required fix rejects initial commits included before it can become eligible for publication | Keep | Same owner. |
| a required fix rejects empty fix before it can become eligible for publication | Keep | Same owner. |
| a required fix rejects dirty fix before it can become eligible for publication | Keep | Same owner. |
| a required fix rejects rewritten implementation before it can become eligible for publication | Keep | Same owner. |

### [run/cli-review.test.ts](../tests/run/cli-review.test.ts)

| Previous test | Decision | Remaining coverage / reason |
| --- | --- | --- |
| verified implementation starts an independent Standards/Spec Review and becomes eligible for publication on passed | Keep | Same owner. |
| with no default cap, every findings round receives a fix and later Reviews resume the original reviewer from the previous reviewed HEAD | Keep | Same owner. |
| disabled Review and initial no_change never start a reviewer | Keep | Same owner. |
| cap=1 still fixes final findings in the exact implementation conversation before publication eligibility | Keep | Same owner. |

### [run/cli-startup.test.ts](../tests/run/cli-startup.test.ts)

| Previous test | Decision | Remaining coverage / reason |
| --- | --- | --- |
| help and version need no Project, credentials, plugin, or delivery resources | Keep | Same owner. |
| init creates a Project without credentials and refuses to overwrite it | Keep | Same owner. |
| EOF during a real Operator Pause returns and reports a cancelled Run | Keep | Same owner. |
| the application entry can be imported from a stdin script | Remove / merge | cli-startup: EOF during real Operator Pause. The real EOF scenario imports the same entry from stdin and executes it; import-only assertion adds no behavior. |

### [run/cli-validation.test.ts](../tests/run/cli-validation.test.ts)

| Previous test | Decision | Remaining coverage / reason |
| --- | --- | --- |
| invalid configuration fails before any external reads or delivery resources | Keep | Same owner. |
| Project selection uses only its named launch-directory child | Keep | Same owner. |
| Review defaults on; disabled Review and maintenance do not require their profiles or prompts | Keep | Same owner. |
| enabled purposes require their profiles, prompts, and maintenance metadata | Keep | Same owner. |
| Run modes are exclusive and auto-merge is restricted before external access | Keep | Same owner. |
| option ordering and configured Target Branch do not change the empty-parent result | Keep | Same owner. |
| ineligible Issue scopes do not dispatch and documentation requires configuration | Keep | Same owner. |

### [run/full-contract-failure.test.ts](../tests/run/full-contract-failure.test.ts)

| Previous test | Decision | Remaining coverage / reason |
| --- | --- | --- |
| five-Issue Run retries a Reservation and accepts native manual correction after automatic exhaustion | Keep | Same owner. |
| cancelling a missing native handoff retains the Batch and resumes only unfinished work before both maintenance barriers | Keep | Same owner. |

### [run/full-contract.test.ts](../tests/run/full-contract.test.ts)

| Previous test | Decision | Remaining coverage / reason |
| --- | --- | --- |
| five Issues complete through Review and two maintenance barriers with Batch size three | Keep | Same owner. |

### [static-checks.test.mjs](../tests/static-checks.test.mjs)

| Previous test | Decision | Remaining coverage / reason |
| --- | --- | --- |
| business modules reject platform and implementation coupling | Keep | Same owner. |
| portable dependencies and adapter wiring remain allowed | Keep | Same owner. |

## Assertion cleanup

- Removed the missing absolute executable check from the installed-artifact test. It exercised Node/OS file lookup, not Core behavior. Installed CLI execution, templates and module resolution remain covered.
