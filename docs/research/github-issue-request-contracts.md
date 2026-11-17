# Can GitHub combine Issue reads and Reservation writes?

Research for [Validate combined Issue reads and Reservation writes](https://github.com/BuddyLabsCo/issue-runner-core/issues/365), under [Reduce GitHub requests across Runner phases](https://github.com/BuddyLabsCo/issue-runner-core/issues/364). Source baseline: `ac3fcc409da0596823fc5545d3d584e5906c0dfc`. Evidence collected on 2026-11-17 against GitHub.com. This branch contains research only and is never merged.

## Answer and boundaries

The accepted phase design is feasible on the normal path: one complete discovery query per round; one fresh Issue-start query plus at most one request containing incremental Reservation writes; no later eligibility/Reservation polling; and one final parent/children query plus a close mutation whose payload confirms closure. A request can read all required fields and return mutation state. It cannot guarantee every connection fits one page, make two writes atomic, or condition the second write on the first write’s success. These are API limits, not reasons to reopen the accepted phase boundaries.

| Phase | Normal-path contract | Reference accounting supplied by the ticket |
| --- | --- | --- |
| Q1 discovery | One complete parent/children/eligibility query per round | 15 gh invocations become 3 across three rounds |
| Q2 Issue start | One fresh read; zero or one combined incremental-write request per Issue | 54 become 6 for three fresh Issues |
| Q3 implementation and Review | No further eligibility/Reservation reads | Remove 12 |
| Q4 later delivery stages | No further eligibility/Reservation reads | Remove 20 |
| Q8 parent closure | One final parent/children read, then a close with returned state | 13 become 2; charge this scan only to Q8 |

These counts describe the supplied historical normal path. They are not measured HTTP totals or universal limits. The audit contains no HTTP telemetry. Pagination, failed requests, uncertain mutation outcomes, and recovery can require additional requests. The read-only proof below demonstrates current query feasibility, not a replay of the historical run.

The remaining policy questions belong to [Define recovery compatibility and request-budget acceptance](https://github.com/BuddyLabsCo/issue-runner-core/issues/367): acceptance of the read/write race window, reconciliation of grouped partial writes using existing recovery, and classification of pagination/recovery requests. This research does not resolve that human-in-the-loop ticket.

## Evidence levels

- **Schema/documentation facts:** GitHub’s current schema and primary documentation establish fields, inputs and return types. GraphQL’s specification establishes serial root mutations and error semantics. Introspection is read-only.
- **Read-only live proof:** the discovery, Issue-start and final-scan queries below executed against existing Issues. Cursor continuation and partial query errors were also observed. No mutation operation was sent to validate these examples.
- **Untested mutation behavior:** the Reservation and closure examples are schema-backed contracts. Permission enforcement, successful mutation payloads, concurrent writers, transport-loss reconciliation, and grouped mutation failure behavior were not exercised on production Issues.

## Fields, IDs and permissions

The following field inventory comes from read-only live introspection of `Issue`, mutation input/payload types and the successful queries below. GitHub documents the same Issue mutation family in its [Issues GraphQL reference](https://docs.github.com/en/graphql/reference/issues).

| Fact or write | Required data |
| --- | --- |
| Repository ownership | `repository.id`, `repository.nameWithOwner` on parent, Issue, child and blocker; compare the expected repository |
| Issue identity | `id` is the opaque GraphQL node ID; `number` is the repository-local CLI identity; retain both |
| Terminal-state handling | `state` and `stateReason`; an open Issue can report `REOPENED`; the existing model normalizes open reasons to null |
| Start eligibility | Complete `labels.nodes { id name }`, `assignees.nodes { id login }`, and `blockedBy.nodes { id number state stateReason repository { id nameWithOwner } }` |
| Implementation/Review snapshot | `title`, `body`, `url` from the fresh Issue-start result |
| Add Reservation label | Issue `id` as `labelableId`; configured repository label `id` as the sole member of `labelIds` |
| Add Runner | Issue `id` as `assignableId`; configured Runner user `id` as the sole member of `assigneeIds` |
| Close parent | Parent Issue `id` as `issueId`; explicit `stateReason: COMPLETED` |
| Scoped start | Explicitly configured parent identity/state plus complete native-child membership/ownership facts; do not derive command scope from a tracker relationship |

Resolve `repository.label(name: $reservation)` and `user(login: $runner)` alongside the fresh query. This avoids a separate label-list or account-ID lookup on the normal path. Missing labels, an unresolved account, or mismatched identities cannot produce a valid write.

The existing label setup/creation path remains separate; a label cannot be created and its server-generated ID fed into a sibling mutation’s input in the same operation.

The example assumes `runnerAccount` resolves to a GitHub user, as the reference run’s `xiakeng` does. A bot/app identity needs its own schema-supported actor resolution, not a fabricated user ID.

GitHub GraphQL requires authentication. For private repositories, configure selected-repository access and Issues read permission. Fine-grained tokens include public-repository read access; classic tokens use `public_repo` for public repositories and appropriate private-repository access when needed. GitHub’s [authentication guide](https://docs.github.com/en/graphql/guides/forming-calls-with-graphql#authenticating-with-graphql) explains that permissions depend on the requested resource.

For intended writes, configure Issues write permission and an acting account allowed to label, assign and close the selected Issues. The [assignee permissions](https://docs.github.com/en/rest/issues/assignees#add-assignees-to-an-issue) and [label permissions](https://docs.github.com/en/rest/issues/labels#add-labels-to-an-issue) document the corresponding repository write permissions; these REST descriptions are supporting permission guidance, not a live verification of GraphQL authorization.

A resolved user ID proves identity, not assignability. Likewise `viewerCanUpdate` is an update hint, not proof that every requested assignment will succeed. Confirm the actual returned markers; HTTP success alone cannot confirm them. This study did not inspect or disclose credential scopes and did not prove any least-privilege token’s write capability. Cross-repository blockers also require visibility of those repositories. Do not interpret an inaccessible/null relationship or an accompanying authorization error as “no blockers.”

The baseline supports only completed and not-planned closed states. Preserve that restriction: map `COMPLETED` to `completed`, `NOT_PLANNED` to `not_planned`, and fail on null/unsupported reasons for closed Issues and blockers. Live introspection also exposed `DUPLICATE` and `REOPENED`; do not silently turn `DUPLICATE` into completion. These validations come from the baseline [tracker parser](https://github.com/BuddyLabsCo/issue-runner-core/blob/ac3fcc409da0596823fc5545d3d584e5906c0dfc/src/adapters/github-tracker.ts#L4) and [blocker reader](https://github.com/BuddyLabsCo/issue-runner-core/blob/ac3fcc409da0596823fc5545d3d584e5906c0dfc/src/run/discovery.ts#L49).

## Q1: combine discovery facts

This is the executed first-page query. The live variables were owner `BuddyLabsCo`, name `issue-runner-core`, number `348`, runner `xiakeng` and reservation `sandcastle:reserved`. The reservation name is configuration, not a hard-coded contract. The historical Issues currently carry `runner:reserved`; the start proof uses that name.

```graphql
query ParentDiscovery(
  $owner: String!, $name: String!, $number: Int!,
  $runner: String!, $reservation: String!
) {
  repository(owner: $owner, name: $name) {
    id nameWithOwner
    label(name: $reservation) { id name }
    issue(number: $number) {
      id number state stateReason
      repository { id nameWithOwner }
      subIssues(first: 100) {
        totalCount
        pageInfo { hasNextPage endCursor }
        nodes {
          id number title body url state stateReason
          repository { id nameWithOwner }
          labels(first: 100) {
            totalCount
            pageInfo { hasNextPage endCursor }
            nodes { id name }
          }
          assignees(first: 100) {
            totalCount
            pageInfo { hasNextPage endCursor }
            nodes { id login }
          }
          blockedBy(first: 100) {
            totalCount
            pageInfo { hasNextPage endCursor }
            nodes {
              id number state stateReason
              repository { id nameWithOwner }
            }
          }
        }
      }
    }
  }
  user(login: $runner) { id login }
  rateLimit { cost remaining }
}
```

The result contains every native child regardless of label, assignee or state. Apply the existing business filters locally only after all required connection pages and validations complete. Preserve numeric Issue ordering, Issue List filtering, Batch-size selection, checkpoint ownership, rejection of foreign children, and external-assignee detection. Do not filter the server query to only ready/unassigned Issues: that would hide facts needed to recognize existing Reservations and invalid terminal states. Source: baseline [discovery and Batch selection](https://github.com/BuddyLabsCo/issue-runner-core/blob/ac3fcc409da0596823fc5545d3d584e5906c0dfc/src/run/discovery.ts#L111).

For parent cancellation/completion, preserve the baseline [parent scope rules](https://github.com/BuddyLabsCo/issue-runner-core/blob/ac3fcc409da0596823fc5545d3d584e5906c0dfc/src/run/parent.ts#L17): cancelled parent stops the Run; completed parent with open children is inconsistent; every closed child must have a supported reason. Foreign children remain unsupported, while foreign blockers are allowed if their state is readable.

## Q2: fresh start facts, explicit command scope

This executed query reads the target, lookup IDs and optional selected-parent facts in one request. `scoped` is derived from the command’s explicit parent scope. For standalone `--issue`, pass `scoped: false`; `$parent` then needs only a valid GraphQL integer and does not cause a parent lookup. Production query construction can omit the unused scoped selection instead. The example’s standalone proof used the real native parent number `348`, showing that the directive still excludes parent scope.

```graphql
query IssueStart($owner:String!,$name:String!,$number:Int!,$runner:String!,$reservation:String!,$scoped:Boolean!,$parent:Int!) {
  repository(owner:$owner,name:$name) {
    id nameWithOwner label(name:$reservation) { id name }
    target:issue(number:$number) {
      ...StartFacts
      parent @include(if:$scoped) { id number repository { id nameWithOwner } }
    }
    configuredParent:issue(number:$parent) @include(if:$scoped) {
      id number state stateReason repository { id nameWithOwner }
      subIssues(first:100) { totalCount nodes { id number repository { id nameWithOwner } } pageInfo { hasNextPage endCursor } }
    }
  }
  user(login:$runner) { id login }
}
fragment StartFacts on Issue {
  id number title body url state stateReason repository { id nameWithOwner }
  labels(first:100) { totalCount nodes { id name } pageInfo { hasNextPage endCursor } }
  assignees(first:100) { totalCount nodes { id login } pageInfo { hasNextPage endCursor } }
  blockedBy(first:100) { totalCount nodes { id number state stateReason repository { id nameWithOwner } } pageInfo { hasNextPage endCursor } }
}
```

With explicit parent scope, verify configured-parent identity, repository and open state, target membership, and the ownership of every returned sibling. Keeping `configuredParent.subIssues` preserves the current `inspect` function’s foreign-child check across the complete scope. `target.parent` offers a direct membership fact, but is not a substitute for that complete sibling validation. Continue `configuredParent.subIssues` independently if it has more pages. A standalone Issue’s native tracker parent never becomes a selected Parent Ticket, cancellation condition or closure target.

Before constructing a mutation, run the existing local eligibility and checkpoint decisions against this fresh complete response. The decision order includes Issue terminal state, configured readiness label, external assignees and open blockers. A server read cannot decide whether a local checkpoint owns the Reservation. The baseline [Issue-start logic](https://github.com/BuddyLabsCo/issue-runner-core/blob/ac3fcc409da0596823fc5545d3d584e5906c0dfc/src/run/standalone.ts#L125) remains the source of policy.

| Remote markers and local context, after eligibility checks | Existing ownership meaning | Needed incremental write |
| --- | --- | --- |
| Neither marker, no valid continuation | Fresh work | Add Reservation label and Runner |
| Runner only, no Reservation label | Runner-only marker is not a complete Reservation | Add label only; preserve existing Runner |
| Reservation label only, no valid ownership | Partial/unowned Reservation | None; do not adopt or auto-repair |
| Both markers, no matching valid checkpoint | Complete but unowned Reservation | None; do not claim |
| Both markers with matching validated continuation | Owned continuation | None; reuse execution context |
| Valid continuation but either marker missing | Recorded Reservation changed | None; stop ordinary continuation |
| Any unrelated assignee | Externally owned | None, even when Runner/label also exists |
| Explicit restart after unrecoverable context, both markers present | Existing operator-approved restart path can retain ownership | No unconditional re-claim; follow restart policy |

The source distinguishes restored continuation from explicit restart (`ownsReservation = restarting && reserved`). It also handles already-completed publication/no-change delivery specially; those branches do not turn a closed Issue into fresh work. Preserve their result validation. Discovery can use checkpoint-file existence to identify a candidate, but continuation must pass full checkpoint validation before adopting it. See [selection coverage](https://github.com/BuddyLabsCo/issue-runner-core/blob/ac3fcc409da0596823fc5545d3d584e5906c0dfc/tests/run/cli-parent-selection.test.ts#L193) and [continuation ownership checks](https://github.com/BuddyLabsCo/issue-runner-core/blob/ac3fcc409da0596823fc5545d3d584e5906c0dfc/src/run/standalone.ts#L389).

Maintenance Tickets retain their separate standalone-marker policy and do not receive ordinary business Reservations. Their lifecycle is not authorization to broaden this study into a new ownership model.

## Incremental Reservation mutation and confirmation

Send the following only for fresh eligible work whose read showed neither marker. It adds one label and one assignee without replacing unrelated values. For a Runner-only marker, emit only the label field with the same state selection. For owned continuation, send no Reservation mutation. Do not use `updateIssue` label/assignee arrays or `replaceActorsForAssignable` as a shortcut for additive writes.

```graphql
mutation ReserveIssue($issue: ID!, $label: ID!, $runner: ID!) {
  addReservation: addLabelsToLabelable(
    input: { labelableId: $issue, labelIds: [$label] }
  ) {
    labelable { ...ReservationState }
  }
  addRunner: addAssigneesToAssignable(
    input: { assignableId: $issue, assigneeIds: [$runner] }
  ) {
    assignable { ...ReservationState }
  }
}

fragment ReservationState on Issue {
  id number state stateReason repository { id nameWithOwner }
  labels(first: 100) {
    nodes { id name }
    pageInfo { hasNextPage endCursor }
  }
  assignees(first: 100) {
    nodes { id login }
    pageInfo { hasNextPage endCursor }
  }
}
```

Read-only introspection confirmed both nullable payload roots and their nullable `labelable`/`assignable` return fields, so both must be validated. A complete error-free `addRunner.assignable` with the expected Issue/repository identity, open state, Reservation label and Runner, and no external assignee, supplies confirmation after both serial writes. For the label-only path, use `addReservation.labelable`. A marker observed positively in a truncated connection proves presence, but a truncated assignee list cannot prove there is no unrelated assignee; complete it before crediting ownership. A missing payload or marker cannot confirm success.

The GraphQL specification guarantees serial execution of top-level mutation fields; it does not supply transaction rollback. The second field’s inputs/directives are fixed before execution, so it cannot test the first field’s returned state. These are deductions from the [serial execution and error rules](https://spec.graphql.org/September2025/#sec-Normal-and-Serial-Execution), together with the live schema’s absence of compare-and-set inputs on these mutations. `clientMutationId` is an optional correlation value; the schema does not promise an idempotency key or lock.

| Response/outcome | Required interpretation |
| --- | --- |
| Both writes return complete valid state, no errors | Confirm the resulting markers from the final payload; keep each operation’s outcome |
| Label succeeds, assignment errors/null | Partial Reservation may exist; do not dispatch or compensate automatically |
| Label errors, assignment succeeds | Runner-only residue may exist; never infer the missing label succeeded |
| Earlier payload selection errors after a write | The write may already have happened; null is not proof of rollback |
| Connection overflow in confirmation | Fetch missing pages before making absence/ownership claims |
| HTTP failure, timeout, lost response or `data: null` | Applied state is uncertain; fresh reconciliation is required |

A nullable first mutation can fail while a later one still executes. A non-null error can instead bubble upward and stop unfinished siblings. The contract must handle both; this study did not induce either mutation failure. Preserve raw alias/path errors and any returned data, then reconcile through existing recovery before deciding a retry.

Do not retry the whole pair blindly or adopt residual markers on the next Run.

The baseline already retains partial Reservations without automatic compensation; see [failed-assignment coverage](https://github.com/BuddyLabsCo/issue-runner-core/blob/ac3fcc409da0596823fc5545d3d584e5906c0dfc/tests/run/cli-parent-selection.test.ts#L260).

This grouping cannot reproduce the old remote read between `addLabel` and `addAssignee`. It cannot prevent an external assignment or parent cancellation after the start read. Returned state can expose some races after writes; it cannot prevent a write that already occurred. The accepted phase design fixes fresh eligibility at start and removes later checks. The follow-up decision must record that the old [between-write and dispatch revalidation tests](https://github.com/BuddyLabsCo/issue-runner-core/blob/ac3fcc409da0596823fc5545d3d584e5906c0dfc/tests/run/cli-parent-revalidation.test.ts#L26) cannot all retain their literal timing guarantees. This is an acceptance/recovery compatibility question, not a request to restore polling or invent a new mechanism.

## Every connection owns its cursor

Children, each child’s blockers, each Issue’s labels and each Issue’s assignees have independent connection positions. GitHub’s [pagination guide](https://docs.github.com/en/graphql/guides/using-pagination-in-the-graphql-api) requires `first`/`last` between 1 and 100 and continuation with `endCursor` until `hasNextPage` is false. `totalCount` alone is not proof that the response is complete.

For each owner-node-ID and connection-name pair, retain a cursor and accumulated validated nodes. Fetch later child pages from the parent ID. Fetch overflow blockers/labels/assignees from that child’s ID, even after the outer child connection ends. Multiple independent continuations may share one request by using aliases with separate variables:

```graphql
query MoreFacts(
  $parent: ID!, $child: ID!, $childrenAfter: String,
  $labelsAfter: String, $assigneesAfter: String, $blockersAfter: String
) {
  parentPage: node(id: $parent) {
    ... on Issue {
      subIssues(first: 100, after: $childrenAfter) {
        nodes {
          id number state stateReason repository { id nameWithOwner }
          labels(first: 100) { nodes { id name } pageInfo { hasNextPage endCursor } }
          assignees(first: 100) { nodes { id login } pageInfo { hasNextPage endCursor } }
          blockedBy(first: 100) {
            nodes { id number state stateReason repository { id nameWithOwner } }
            pageInfo { hasNextPage endCursor }
          }
        }
        pageInfo { hasNextPage endCursor }
      }
    }
  }
  childPage: node(id: $child) {
    ... on Issue {
      id number repository { id nameWithOwner }
      labels(first: 100, after: $labelsAfter) {
        nodes { id name } pageInfo { hasNextPage endCursor }
      }
      assignees(first: 100, after: $assigneesAfter) {
        nodes { id login } pageInfo { hasNextPage endCursor }
      }
      blockedBy(first: 100, after: $blockersAfter) {
        nodes { id number state stateReason repository { id nameWithOwner } }
        pageInfo { hasNextPage endCursor }
      }
    }
  }
}
```

This continuation shape executed read-only with parent 348, child 349 and separate cursor variables. New child pages use the full required discovery projection; fetch `title`, `body`, `url` too if that projection will be reused as an execution snapshot. Emit only unfinished connections, rather than restarting completed ones. Reject null/wrong node types, malformed or repeated non-advancing cursors, identity mismatches and unexpected null nodes; deduplicate by node ID. Never reuse the parent cursor as a child cursor merely because their string values happen to match.

Do not select or reserve candidates until every needed discovery connection has completed. Do not short-circuit blocker validation when one open blocker is found: the current reader validates all pages, including unsupported closed states. Preserve those trust-boundary checks. After pagination, sort children numerically for business selection; API pagination order is not that business order.

`gh api --paginate` documents one `$endCursor` pagination input. It does not manage arbitrary independently nested cursors on behalf of this workflow. A single gh invocation can also make several HTTP requests, so count invocations and HTTP requests separately. Source: [GitHub CLI API manual](https://cli.github.com/manual/gh_api).

GitHub limits each operation to 500,000 requested nodes, permits resource-limit partial results and errors, and recommends reducing/splitting expensive selections. The demonstrated nested 100-child query stayed below the node ceiling but its breadth does not guarantee timing or resource success for larger repositories. Smaller pages or additional requests can be unavoidable. Source: [rate and query limits](https://docs.github.com/en/graphql/overview/resource-limitations#node-limit).

## Query errors are not empty facts

The client must parse the entire GraphQL response envelope. An absent/null `data`, null required object, malformed connection, or error affecting required facts leaves the decision incomplete. Never default `labels`, `assignees`, `blockedBy` or `subIssues` to an empty list on failure. Retain `errors[].message`, `type` when GitHub supplies it, `path`, `locations` and any extensions for diagnosis and operation reconciliation.

A path-free error is request-wide. An alias-specific error identifies affected data, but does not erase successful sibling facts. For eligibility, an affected required fact blocks the decision; unrelated successful facts remain evidence rather than authority to continue. For writes, retain per-alias outcomes because some side effects may already have succeeded. These handling recommendations follow GraphQL’s error model; the read-only failure below also confirms GitHub returns partial data in practice.

The existing [GitHub client](https://github.com/BuddyLabsCo/issue-runner-core/blob/ac3fcc409da0596823fc5545d3d584e5906c0dfc/src/adapters/github-client.ts#L16) rejects most nonzero gh exits using stderr and drops stdout. The live partial-error query exited 1 while stdout still contained valid JSON `data` and `errors`. A later implementation therefore needs to retain the GraphQL envelope on error exits, using the existing command boundary or an equivalent narrow change. Merely adding a JSON parser on its current success path would lose grouped-mutation failure information. This research changes no adapter code.

## Q8: final scope scan and confirmed parent closure

This executed final-scan query intentionally omits blockers, labels and assignees. It returns every child’s terminal state and repository ownership. It is charged to Q8, not another Q1 round.

```graphql
query ParentClosure($owner:String!,$name:String!,$number:Int!) {
  repository(owner:$owner,name:$name) {
    id nameWithOwner issue(number:$number) {
      id number state stateReason repository { id nameWithOwner }
      subIssues(first:100) { totalCount nodes { id number state stateReason repository { id nameWithOwner } } pageInfo { hasNextPage endCursor } }
    }
  }
}
```

Close only after the complete fresh scan finds an open parent and no open children, with supported closure reasons and same-repository children. A cancelled parent keeps its cancellation meaning. An already completed parent needs no redundant close. Preserve the existing empty-parent/no-work behavior; removing requests does not make an initially empty parent eligible for automatic closure.

The close request can return the Issue state directly. This schema-backed example was not executed:

```graphql
mutation CompleteParent($parent: ID!) {
  completeParent: closeIssue(input: { issueId: $parent, stateReason: COMPLETED }) {
    issue {
      id number state stateReason repository { id nameWithOwner }
      subIssues(first: 100) {
        nodes { id number state stateReason repository { id nameWithOwner } }
        pageInfo { hasNextPage endCursor }
      }
    }
  }
}
```

The nullable returned `issue` is sufficient to confirm the parent’s own closure when its identity matches and state/reason are `CLOSED`/`COMPLETED`, with no relevant errors. The selected child states also preserve the baseline’s post-close scope validation in the same response. Confirm they are complete, all terminal, supported and local; otherwise report the incomplete/inconsistent result instead of success. The mutation does not need separate blocker reads or a success-path follow-up Issue GET. GitHub documents `closeIssue.issue` as the closed Issue; live introspection confirmed the return shape.

`closeIssue` has no precondition such as “close only if all children remain closed” or expected modification version. A child can reopen or be added between scan and mutation; the payload can reveal the resulting inconsistency but does not make the close atomic with its child scan. Lost/partial closure responses still require a fresh scope read for reconciliation. This limitation existed between the baseline’s separate requests too; a mutation payload is observation of returned state, not a durable lock against later edits.

## Checkpoint recovery stays authoritative locally and fresh remotely

The existing checkpoint validation checks the input hash, exact arguments, project/repository/Issue/branch/purpose, execution identity, phase, native Agent context, accepted result metadata and retained Worktree requirements. Batch checkpoints also preserve membership and Run identity. Keep those local validations. An old audit record, saved Issue snapshot or marker pair does not replace them. Sources: [restoreExecution](https://github.com/BuddyLabsCo/issue-runner-core/blob/ac3fcc409da0596823fc5545d3d584e5906c0dfc/src/run/execution-recovery.ts#L138) and [Batch recovery](https://github.com/BuddyLabsCo/issue-runner-core/blob/ac3fcc409da0596823fc5545d3d584e5906c0dfc/src/run/discovery.ts#L79).

At process restart or an existing retry/reconciliation boundary, acquire fresh complete remote facts before deciding ownership or retrying an uncertain write. Do not replay prior Q1/Q2 response snapshots from checkpoints. Continue only a valid owned Reservation, with the existing completed-delivery exceptions; changed input hashes do not adopt unrelated residual Reservations. Explicit operator restart after unrecoverable context archives the checkpoint and follows its existing distinct ownership path. Native Agent identity, local workspace and result validation remain necessary after removing later tracker polling.

The current recovery journal stores separate `add_reservation_label` and `add_runner_assignee` operation keys. A combined request still has two possible side effects and must preserve enough per-effect evidence for existing reconciliation. This study does not choose whether the new adapter maps them to existing keys or introduces a compatible grouped record. The follow-up HITL ticket must settle how old interrupted checkpoints remain readable and how label-only, Runner-only and unknown results resume without automatic adoption or compensation. A successful remote marker pair alone is insufficient evidence of local ownership.

## Read-only live results and reproducibility

All example reads used `gh api graphql`, a JSON body file, the existing authenticated CLI session and no preview headers. For example, save the first query as `discovery.graphql`, build a JSON envelope with those variables, and run `gh api graphql --input discovery.json`. The complete response, including errors, must be retained even when gh exits nonzero. No token value belongs in evidence.

| Probe | Observed result on 2026-11-17 | What it proves |
| --- | --- | --- |
| Full Q1 read of parent 348 | `CLOSED`/`COMPLETED`; children 349, 350, 351; outer `hasNextPage: false`; all nested connections complete; no errors; GraphQL cost 3 points | Required fields can be read together for the reference hierarchy today; cost points are not HTTP request count |
| Children 349/350/351 | Each has two labels and one assignee `xiakeng`; blocker counts 0/1/1; both blockers are completed Issue 349 | Real blocker and marker fields are populated; these closed Issues do not prove fresh-work Reservation success |
| Label/account lookup | `sandcastle:reserved` resolves to `LA_kwDOVbkYOs8AAAADAJmtrw`; `xiakeng` to `MDQ6VXNlcjE5MjIyMTE1` | Required ID lookups can share the read; IDs are examples, never constants |
| Q2 read, `scoped: true`, target 349, parent 348 | Target native parent is 348; configured parent returns all three children; no errors | Explicit parent state and complete membership facts share a request |
| Same Q2 read, `scoped: false` | Target’s native-parent field and configured-parent field omitted by GraphQL; no errors | Standalone execution need not acquire parent restrictions from tracker hierarchy |
| Q8 final-scan read of 348 | Parent and three children all closed/completed, no errors; no blocker selection | Final scope facts need one request on this non-paginated data |
| `subIssues(first:1)` then `after:"MQ"` | First page 349/cursor `MQ`/next true; second page 350/cursor `Mg`/next true | A real child continuation cursor works; this two-page probe deliberately did not drain page 3 |
| Issue 349 `labels(first:1)` then its own `after:"MQ"` | First label `ready-for-agent`; second `runner:reserved`; next false | Independent label continuation works; coincidentally equal cursor strings do not imply shared position |
| Issue 349 `assignees(first:1)`; Issue 350 `blockedBy(first:1)` | One assignee and one blocker respectively, both next false | These connection shapes work; multi-page assignee overflow was not induced |
| Follow-up decision 367 `blockedBy(first:1)`, then its own `after:"MQ"` | First blocker 366/cursor `MQ`/next true; second blocker 365/cursor `Mg`/next false | A real two-page blocker connection drains independently |
| `MoreFacts` alias continuation above, all cursors `MQ` | Parent children 350 and 351; child 349 label `runner:reserved`; exhausted assignees/blockers return empty pages | Independent owner/connection queries work in one request; equal cursor strings are coincidental |
| Partial-error query below | Valid viewer/repository plus `missing:null`, `NOT_FOUND`, path `["repository","missing"]`; gh exit 1 | Partial data and field errors coexist; transport/CLI success alone is insufficient |
| Schema introspection | Issue relationships, inputs, payloads and nullable roots match the examples | Mutation field contracts exist; does not prove execution authorization or outcomes |

The executed partial-error query was read-only:

```graphql
query {
  viewer { login }
  repository(owner: "BuddyLabsCo", name: "issue-runner-core") {
    nameWithOwner
    missing: issue(number: 2147483647) { id number }
  }
}
```

The live parent ID was `I_kwDOVbkYOs8AAAABd7yjcA`, repository ID `R_kgDOVbkYOg`, and target 349 ID `I_kwDOVbkYOs8AAAABd77euQ`. Query IDs fresh; these values are evidence only. Introspection attempts containing four uses of `__Type.inputFields` or `__Type.fields` were rejected by GitHub’s `INTROSPECTION_LIMIT_EXCEEDED`; splitting those inspections into at most two uses succeeded. That research-tool limit does not limit ordinary Issue queries.

## When more requests are unavoidable

1. Any required connection reports another page, or a resource/node/time limit requires smaller selections.
2. Label/account resolution fails and configuration/setup needs correction; a missing label must be created before its new ID is used.
3. A required fact or confirmation field errors, is null, malformed or incomplete.
4. A grouped write has partial/unknown success, or the response is lost; reconcile fresh remote facts before any retry.
5. An interrupted Run restarts and must validate current ownership and reconcile pending effects; checkpoint snapshots cannot serve as fresh remote facts.
6. The final close payload fails to confirm identity/state or returns inconsistent/paginated child state.

Do not restore Q3/Q4 polling to achieve these exception paths. Keep normal-path budgets separate from pagination, reconciliation, repair, local Git operations and Agent interactions. Recovery-journal compatibility, the remaining race guarantees and executable request accounting remain decisions for [Define recovery compatibility and request-budget acceptance](https://github.com/BuddyLabsCo/issue-runner-core/issues/367).

No runtime implementation, production Issue mutation trial, full workflow/E2E run, permission-matrix experiment or performance benchmark was performed. The principal remaining risks are concurrent edits between read and write, partial grouped writes, and migration of existing interrupted-operation records.
