# GitHub publication, CI, and merge request contracts

Research for [decision ticket #366](https://github.com/BuddyLabsCo/issue-runner-core/issues/366), under [map #364](https://github.com/BuddyLabsCo/issue-runner-core/issues/364). Inspected on 2026-11-17 against source commit `ac3fcc409da0596823fc5545d3d584e5906c0dfc` and installed GitHub CLI `2.75.1`. This branch contains research only and must not be merged.

## Finding

The agreed combined queries are feasible. Direct `gh api graphql` calls can provide one HTTP request for each complete, single-page observation. Q5 can use three such calls plus one Git push; Q6 can use one per actual poll; Q7 can use one expected-head merge mutation followed by one PR/Issue query when integration and Issue closure are immediately observable.

These are normal-path budgets, not unconditional HTTP ceilings. Publication candidate completeness, check-context pagination, queue delay, delayed Issue closure, and recovery can require more requests. In particular, current publication matching cannot be replaced by a source-branch-only query. `gh pr create`, `gh pr checks`, and `gh pr merge` also hide requests inside one CLI invocation. The concrete contracts below preserve the accepted direction and expose its limits.

| Phase | Accepted gh invocation budget | HTTP budget when using direct operations | Important exception |
| --- | --- | --- | --- |
| Q5, fresh Issue | 3, plus 1 separate Git push | 3 if both candidate connections fit one page | Complete candidate pagination; uncertain push/create reconciliation |
| Q6, actual CI poll | 1 | 1 if all check contexts fit one page | More than 100 contexts; incomplete/error response |
| Q7, immediate normal success | 1 merge + 1 result query | 2 with direct mutation/query | Queue, stale mergeability, rejection, closure, pagination, response loss |

The reference estimates remain 72 → 9 gh invocations for Q5, 306 → 36 for Q6 at the original 13 + 11 + 12 polls, and 51 → 6 for Q7 across three Issues. These are the [ticket's audit/source reconstruction](https://github.com/BuddyLabsCo/issue-runner-core/issues/366), not measured historical HTTP traffic. Optimized execution can change the number of actual polls.

## Evidence and counting

The following live operations were read-only. Each of the four composed GraphQL queries in this report returned successfully, and `GH_DEBUG=api` showed one `POST /graphql` each. No PR was created, merged, queued, or edited; no settings, CI, or production branch was changed.

| Probe | Observed result |
| --- | --- |
| Pre-push query shape, using existing `refs/heads/auto-release` | Repository ID `R_kgDOVbkYOg`; ref OID `b2384c31cda93c3413d691993d275c3ee6f6d90d` |
| Combined publication query | 10 source-branch PRs; 99 PRs targeting `main`; both `hasNextPage:false` |
| Combined CI query for PR #363 | Exact same PR/remote/last-commit OID; 3 check runs, 2 required successes, 1 optional skipped run; no further page |
| Combined result query for PR #363 and Issue #366 | PR `OPEN`, Issue `OPEN`, `stateReason:null`, full one-label result; validates shape, not delivery success |
| Existing `gh pr checks 363 --repo BuddyLabsCo/issue-runner-core --required --json name,state,link,bucket` | Four GraphQL HTTP requests per invocation in two observations; same two required successes |

These observations are time-specific evidence, not repository assumptions. A real fresh publication must require an absent pre-push branch; the existing branch above was only a query-shape probe. The reused `auto-release` branch has historical PRs and would fail Runner's uniqueness test: it is not a valid Runner publication fixture. The target history already has 99 entries, so a single-page guarantee is particularly short-lived here.

Read-only schema introspection also confirmed `Repository.pullRequests` arguments, `ref(qualifiedName:)`, mutation input types and payload fields. Input inspection included `CreatePullRequestInput`, `MergePullRequestInput`, `EnablePullRequestAutoMergeInput`, and `EnqueuePullRequestInput`. GitHub rejected introspection selections using the same introspection field three times; splitting into groups of at most two succeeded. Mutation shapes below were checked against that schema and documentation, not executed.

Count three things separately:

- A gh invocation is one spawned process. The baseline adapter records commands, not every request inside gh.
- An HTTP request is a network operation: pagination, feature detection, repository resolution, and PR finding can add requests. `gh api --paginate` still makes multiple requests; one process does not make it one request. The [gh api manual](https://cli.github.com/manual/gh_api) documents pagination and `--input` request bodies.
- A Git push is one Git operation in these budgets. Its negotiation, object transfer, and authentication transport are separate from GitHub REST/GraphQL counting. Fetches needed for existing repair/ancestry checks also remain Git operations.

The audited CLI source is pinned to the installed [v2.75.1 release](https://github.com/cli/cli/releases/tag/v2.75.1). Other versions can change hidden request counts. Do not report a hypothetical exact count for unexecuted create/merge commands.

## Q5: branch observation, push, publication observation, creation

### Existing matching contract

At the source baseline, [`listPullRequests`](https://github.com/BuddyLabsCo/issue-runner-core/blob/ac3fcc409da0596823fc5545d3d584e5906c0dfc/src/adapters/github-code-host.ts#L109) retrieves all REST PR pages, then excludes PRs whose head repository differs from the publication repository, comparing repository names without case sensitivity. [`matchPublication`](https://github.com/BuddyLabsCo/issue-runner-core/blob/ac3fcc409da0596823fc5545d3d584e5906c0dfc/src/run/publication.ts#L331) then defines related candidates as:

```text
source branch == recorded branch
OR (target branch == recorded target AND PR head == expected head)
```

If none exist, return absent only when no PR identity was recorded. Otherwise there must be exactly one related PR. It must have the exact source branch, target branch, and expected head, be open or merged, be non-draft, and, if recorded, match both PR number and URL. Closed-unmerged candidates and otherwise-invalid related candidates are not filtered out before counting: they cause rejection. A PR on another source branch but the same target/head also causes rejection. Title/body are accepted publication intent, not remote candidate matching keys.

### First gh call: pre-push branch query

```graphql
query PrePush($owner: String!, $name: String!, $ref: String!) {
  repository(owner: $owner, name: $name) {
    id
    nameWithOwner
    ref(qualifiedName: $ref) { name target { oid } }
  }
}
```

Use the full `refs/heads/<recorded branch>` string. Require a valid accessible repository and `ref:null` before recording a fresh publication intent, then persist intent before pushing. A null repository, GraphQL error, or inaccessible private repository is not evidence of an absent branch. The repository ID can be reused immediately for creation. The schema exposes exact-name ref lookup through [Repository](https://docs.github.com/en/graphql/reference/repos#repository).

Retain local workspace, accepted handoff, commit, and ancestry verification. Then perform the existing Git push of the recorded commit to the recorded branch. No adjacent duplicate remote-head query is needed on fresh normal success.

### Second gh call: combined remote head and candidate union

```graphql
query Publication(
  $owner: String!, $name: String!, $ref: String!,
  $branch: String!, $base: String!,
  $headAfter: String, $baseAfter: String
) {
  repository(owner: $owner, name: $name) {
    id
    nameWithOwner
    ref(qualifiedName: $ref) { name target { oid } }
    source: pullRequests(
      first: 100, after: $headAfter, headRefName: $branch,
      states: [OPEN, CLOSED, MERGED]
    ) {
      nodes { ...PublicationIdentity }
      pageInfo { hasNextPage endCursor }
      totalCount
    }
    target: pullRequests(
      first: 100, after: $baseAfter, baseRefName: $base,
      states: [OPEN, CLOSED, MERGED]
    ) {
      nodes { ...PublicationIdentity }
      pageInfo { hasNextPage endCursor }
      totalCount
    }
  }
}
fragment PublicationIdentity on PullRequest {
  id number url headRefName baseRefName headRefOid
  headRepository { nameWithOwner }
  state isDraft createdAt
}
```

Require the remote ref OID to equal the intended pushed head. Union the two completed candidate sets by immutable PR ID so a PR appearing in both connections counts once. Apply the baseline same-repository filter, then the exact related predicate and validation above. `createdAt` supplies future merge ordering without another read.

The schema has source- and target-branch filters but no head-OID filter on `Repository.pullRequests`; therefore the target connection must be filtered locally by expected OID. Both connections include all states. Return early on an already-proven mismatch/duplicate if desired, but absence or uniqueness requires complete relevant coverage.

**Pagination limitation:** each connection is capped at 100 items per page. If either has `hasNextPage:true`, fetch its remaining pages before accepting uniqueness/absence. Independent cursors are needed; blindly applying one generic cursor to both connections is incorrect. These are extra HTTP requests, even if some wrapper keeps one logical CLI operation. Arbitrary historical completeness cannot be guaranteed by a fixed number of aliases in one request. See [GitHub pagination](https://docs.github.com/en/graphql/guides/using-pagination-in-the-graphql-api).

`Commit.associatedPullRequests` is not an exact shortcut: its documented scope is the merged PR introducing the commit, plus open associated PRs when the commit is outside the default branch. That does not establish the current all-state candidate contract. [Commit reference](https://docs.github.com/en/graphql/reference/commits#commit). Likewise, a search-index query is not evidence that every exact head match was examined.

### Third gh call: direct PR creation

```graphql
mutation CreatePublication($input: CreatePullRequestInput!) {
  createPullRequest(input: $input) {
    pullRequest {
      id number url headRefName baseRefName headRefOid
      headRepository { nameWithOwner }
      state isDraft createdAt
    }
  }
}
```

Supply `repositoryId`, `baseRefName`, `headRefName`, accepted `title`/`body`, and `draft:false`; preserve the existing default `maintainerCanModify:true`. Same-repository publication needs no fork discovery. The direct creation mutation is also what [gh's creation API helper](https://github.com/cli/cli/blob/v2.75.1/api/queries_pr.go) ultimately uses. A single REST `POST /repos/{owner}/{repo}/pulls` with `head`, `base`, `title`, `body`, and `draft:false` is an alternative, returning identity/head metadata without a separate lookup; see [REST create PR](https://docs.github.com/en/rest/pulls/pulls#create-a-pull-request).

Persist `creationAttempted`/pending intent before dispatch. Validate returned repository, PR identity, branch/base, state, draft flag, and head against intent before recording success. Creation has no expected-head compare-and-set field: a concurrent branch change between observation and creation must be detected from the response or next combined observation, never accepted as the intended publication.

The current [`gh pr create` path](https://github.com/cli/cli/blob/v2.75.1/pkg/cmd/pr/create/create.go) resolves repository context and checks for an existing PR before submitting. Passing explicit `--head` avoids its push/fork path, but does not remove those API reads. Thus retaining this convenience command satisfies three **gh invocations**, not three **HTTP requests**. Direct creation removes its redundant finder round trip; validation must remain in Runner.

### Uncertain outcomes

The baseline [publication workflow](https://github.com/BuddyLabsCo/issue-runner-core/blob/ac3fcc409da0596823fc5545d3d584e5906c0dfc/src/run/publication.ts#L154) reconciles uncertain creation before retry and requires operator input when no exact match exists after a prior attempt. Keep that behavior. A timeout/connection loss after creation can still mean a PR exists. Re-run the complete combined observation, adopt only an exact unique result, and retain the second reconciliation after an operator wait. Never infer absence from an incomplete page or blindly replay creation. An uncertain push likewise needs the recorded branch/head reconciliation before replay. These recovery calls are outside the fresh normal-path budget.

## Q6: one combined known-PR observation per CI poll

```graphql
query Poll(
  $owner: String!, $name: String!, $number: Int!,
  $ref: String!, $after: String
) {
  repository(owner: $owner, name: $name) {
    nameWithOwner
    ref(qualifiedName: $ref) { target { oid } }
    pullRequest(number: $number) {
      id number url headRefName baseRefName headRefOid
      headRepository { nameWithOwner }
      state isDraft createdAt mergedAt mergeable mergeStateStatus
      isInMergeQueue isMergeQueueEnabled
      autoMergeRequest { enabledAt }
      mergeQueueEntry { id }
      commits(last: 1) {
        nodes {
          commit {
            oid
            statusCheckRollup {
              contexts(first: 100, after: $after) {
                totalCount
                pageInfo { hasNextPage endCursor }
                nodes {
                  __typename
                  ... on CheckRun {
                    name status conclusion startedAt completedAt detailsUrl
                    isRequired(pullRequestNumber: $number)
                    checkSuite { workflowRun { event workflow { name } } }
                  }
                  ... on StatusContext {
                    context state targetUrl createdAt
                    isRequired(pullRequestNumber: $number)
                  }
                }
              }
            }
          }
        }
      }
    }
  }
}
```

This exact shape succeeded live. `isRequired` can use the known PR number on both union members, avoiding a preliminary ID lookup. Alternatively use a recorded PR node ID. Check contexts include both Check Runs and commit Status Contexts; [CheckRun](https://docs.github.com/en/graphql/reference/checks#checkrun) and [StatusCheckRollup](https://docs.github.com/en/graphql/reference/commits#statuscheckrollup) define these fields. A combined rollup state is not the required-only answer.

For an open PR, require the returned number/URL and branches to match recorded identity, same head repository, non-draft allowed state, and both remote ref and last-commit OID to equal the expected PR head. A missing open-PR ref or mismatched head stops/repairs according to existing policy. A merged PR may have a deleted ref; its retained `headRefOid` remains the relevant original head evidence. A merged observation can unwind ongoing repairs exactly as the current confirmation path does.

Q6 intentionally observes the **recorded PR**, not the full Q5 candidate universe. Do not silently reintroduce the global scan into each poll. Moving candidate uniqueness to publication/reconciliation is the accepted temporal boundary, not a new guarantee that no other related PR can ever appear later.

### Preserve gh's required-check projection

The pinned [gh query builder](https://github.com/cli/cli/blob/v2.75.1/api/query_builder.go#L255) reads the last PR commit and each context's `isRequired`. The pinned [aggregation code](https://github.com/cli/cli/blob/v2.75.1/pkg/cmd/pr/checks/aggregate.go) removes repeated runs by latest `startedAt` first, using status-context name separately from the check key `(name, workflow name, workflow event)`, then filters required checks. Keep that order. Workflow/event fields in the query support this projection.

For a Status Context, use its state/name/target URL. For a Check Run, use status until `COMPLETED`, then conclusion; use its name/details URL. Preserve empty-link fallback behavior. Map states as follows, with unknown/future values remaining pending:

| State | Bucket |
| --- | --- |
| `SUCCESS` | `pass` |
| `SKIPPED`, `NEUTRAL` | `skipping` |
| `ERROR`, `FAILURE`, `TIMED_OUT`, `ACTION_REQUIRED` | `fail` |
| `CANCELLED` | `cancel` |
| Everything else, including `EXPECTED`, `REQUESTED`, `WAITING`, `QUEUED`, `PENDING`, `IN_PROGRESS`, `STALE` | `pending` |

The repository's [GitHub client](https://github.com/BuddyLabsCo/issue-runner-core/blob/ac3fcc409da0596823fc5545d3d584e5906c0dfc/src/adapters/github-client.ts#L18) converts gh's “no checks reported” and “no required checks reported” errors to `[]`. The [publication loop](https://github.com/BuddyLabsCo/issue-runner-core/blob/ac3fcc409da0596823fc5545d3d584e5906c0dfc/src/run/publication.ts#L265) accepts that empty set after discovery grace. Preserve this: a present last commit with a null/empty rollup, or only optional contexts, produces no required checks. A missing PR/commit, inaccessible field, or GraphQL error does not. This preserves existing behavior; it does not prove that an unreported required context can never appear later.

Keep the 30-second `discoveryNotBefore`, existing deadline initialization, ten-second pending interval bounded by remaining timeout, timeout intervention, and CI repair path. Fail/cancel enters existing repair; pending continues polling; pass/skipping/empty becomes ready. No standalone head/PR confirmations are needed immediately around the same complete observation. Local validation still runs at the appropriate workflow boundaries.

### Pagination and conflicts

There is no required-only argument on `contexts`; the client must inspect all returned contexts before filtering. `hasNextPage:true` means the first page cannot prove required checks pass or are absent. Fetch all pages, verify the PR/remote/commit head remains the same, and discard/restart an observation that spans a head change. Do not treat incomplete data as ready. A strict one-HTTP-request ceiling for arbitrary PRs is incompatible with this completeness requirement; counting a page as the next scheduled poll would change polling semantics. [Pagination limits](https://docs.github.com/en/graphql/guides/using-pagination-in-the-graphql-api).

Carry mergeability in this observation. `CONFLICTING` is an explicit conflict and can enter existing conflict repair. `UNKNOWN` is calculation in progress, not conflict evidence. `MERGEABLE` addresses conflicts, not all policy requirements; `mergeStateStatus` and queue fields are needed for CLI-equivalent merge dispatch. These are distinct [PR schema facts](https://docs.github.com/en/graphql/reference/pulls#pullrequest). A base update after the last poll can invalidate mergeability without changing the PR head, so rejection/conflict recovery still needs fresh observations.

The [gh checks implementation](https://github.com/cli/cli/blob/v2.75.1/pkg/cmd/pr/checks/checks.go#L138) finds the PR, performs feature detection, and fetches/paginates contexts. Its extra internal requests explain why replacing only its outer invocation count does not establish the Q6 network budget.

## Q7: expected-head merge and combined delivery observation

Use `createdAt` and PR number already returned during publication/CI to preserve the current [`integrateBatch`](https://github.com/BuddyLabsCo/issue-runner-core/blob/ac3fcc409da0596823fc5545d3d584e5906c0dfc/src/run/integration.ts#L296) order: oldest creation time first, then PR number. No fresh ordering lookup is necessary. Dispatch from the last accepted PR facts; do not repeat Issue eligibility or Reservation checks after Issue start.

### Direct merge operation

```graphql
mutation Squash($input: MergePullRequestInput!) {
  mergePullRequest(input: $input) {
    pullRequest { id number headRefOid state mergedAt }
  }
}
```

Set `pullRequestId` to the recorded node ID, `mergeMethod:SQUASH`, and `expectedHeadOid` to the accepted published head, including any accepted repair head. The server checks this head at merge time; the result query must still confirm delivery. Do not compare the squash commit's OID to the PR head OID: they normally differ. The [gh merge HTTP helper](https://github.com/cli/cli/blob/v2.75.1/pkg/cmd/pr/merge/http.go#L43) forwards the same expected-head constraint.

A single REST `PUT /repos/{owner}/{repo}/pulls/{number}/merge` with `merge_method:"squash"` and `sha:<expected head>` is also possible. Its documented mismatch/error responses include 409 and 405; these are not all conflicts. GraphQL mutations can fail through an `errors` response even when HTTP succeeds. Preserve failure detail and reconciliation instead of assuming transport success means accepted merge. [REST merge](https://docs.github.com/en/rest/pulls/pulls#merge-a-pull-request).

### Queue and admin semantics

`gh pr merge --squash --match-head-commit <sha> [--admin]` is one gh invocation, but its [implementation](https://github.com/cli/cli/blob/v2.75.1/pkg/cmd/pr/merge/merge.go#L467) first finds PR/queue facts and then mutates. `--admin` is not a GraphQL input flag. It changes client policy gates and queue bypass selection; backend permission/rules still govern success. Replacing it with a direct mutation must retain these branches using Q6 metadata:

| Observed state / configuration | Preserve existing behavior |
| --- | --- |
| Already merged | Confirm delivery; do not mutate again |
| Already queued or auto-merge requested | Observe completion; do not enqueue/enable again |
| Queue required, `adminMerge:false` | Use expected-head `enablePullRequestAutoMerge`, matching gh's current queue route |
| Queue required, `adminMerge:true` | Attempt direct merge; backend must allow bypass |
| No queue, `adminMerge:false` | Preserve gh's `BLOCKED`/`BEHIND` rejection gates and `DIRTY` conflict rejection |
| No queue, `adminMerge:true` | Allow the attempt through `BLOCKED`/`BEHIND`; never bypass `DIRTY` conflict validation |

The two quoted policy states and `DIRTY` mapping come from [gh's explicit gate](https://github.com/cli/cli/blob/v2.75.1/pkg/cmd/pr/merge/merge.go#L663). This matters when the token has elevated rights: merely omitting an imaginary admin field would not preserve `adminMerge:false`. Last-observed policy facts can become stale; expected-head protection does not lock base policy or queue settings. A rejection is an exceptional fresh-observation path, not grounds to merge a different head.

```graphql
mutation QueueWhenReady($input: EnablePullRequestAutoMergeInput!) {
  enablePullRequestAutoMerge(input: $input) {
    pullRequest {
      id headRefOid state
      autoMergeRequest { enabledAt }
      mergeQueueEntry { id }
    }
  }
}
```

Use recorded `pullRequestId`, `expectedHeadOid`, and `mergeMethod:SQUASH`. Current gh sets its auto-merge route for a required queue; queue configuration determines the eventual strategy. `enqueuePullRequest(input:{pullRequestId,expectedHeadOid})` exists but is not a silent substitute for enable-when-ready behavior: direct enqueue can require prerequisites to be met already. Neither operation means integration completed. GitHub's [merge queue guide](https://docs.github.com/en/pull-requests/how-tos/merge-and-close-pull-requests/merging-a-pull-request-with-a-merge-queue) explains waiting, queue checks, and administrator bypass.

The mutation input/payload shapes above were confirmed by live introspection. They were not tested with an actual queue or admin merge. These paths retain the accepted one-dispatch intent, while normal Q7's two total calls only hold if the next observation already sees completion.

### Combined result query

```graphql
query Result(
  $owner: String!, $name: String!, $number: Int!, $issue: Int!
) {
  repository(owner: $owner, name: $name) {
    nameWithOwner
    pullRequest(number: $number) {
      id number url headRefName baseRefName headRefOid
      state mergedAt createdAt mergeable
      autoMergeRequest { enabledAt }
      mergeQueueEntry { id }
      mergeCommit { oid }
    }
    issue(number: $issue) {
      id number url state stateReason
      labels(first: 100) {
        nodes { name }
        pageInfo { hasNextPage endCursor }
        totalCount
      }
    }
  }
}
```

This query succeeded live. Validate exact PR identity and expected original `headRefOid`, merged state/evidence, and exact Issue identity. Require Issue `state:CLOSED`, `stateReason:COMPLETED`, and a complete observed label set before persisting delivered progress. Record `deliveryLabels` as currently done; do not invent a new required delivery label or infer labels from the start snapshot. Closed with another reason earns no delivery credit. [Issue state/reason and labels](https://docs.github.com/en/graphql/reference/issues#issue).

If the label connection is incomplete, page it before recording the complete label set. If the PR is merged but Issue is still open, existing explicit completed-closure and response-loss reconciliation remain available, with a further result observation. Do not fold unrelated Issue eligibility/Reservation checks back into that closure read.

Automatic closure is conditional: closing keywords take effect for PRs targeting the repository's default branch. PRs targeting another branch, including the repository's E2E acceptance branches, do not get that behavior from `Closes #N`. This requires the existing closure fallback and exceeds normal Q7's two-call assumption. Even with a default-branch target, the first query need not observe all side effects immediately. [GitHub's linking/closure rules](https://docs.github.com/en/issues/tracking-your-work-with-issues/using-issues/linking-a-pull-request-to-an-issue).

### Rejection, conflict, and recovery paths

Preserve the source workflow's [merge reconciliation](https://github.com/BuddyLabsCo/issue-runner-core/blob/ac3fcc409da0596823fc5545d3d584e5906c0dfc/src/run/integration.ts#L139) and [repair validation](https://github.com/BuddyLabsCo/issue-runner-core/blob/ac3fcc409da0596823fc5545d3d584e5906c0dfc/src/run/repair.ts#L149):

- Persist pending merge intent before dispatch. On response loss, read exact PR/Issue results before replaying; merged or requested state can reconcile the operation without another mutation.
- On rejection, query fresh state. Explicit `CONFLICTING` (or existing positively identified conflict rejection) enters conflict repair. Permission, policy, rate limit, and transient errors are not conflicts. `UNKNOWN` retains observation/timeout behavior, including after exhausted repair authorization.
- A later explicit conflict after queue/request observation enters existing repair. Accepted repair pushes change the expected head only after existing handoff, local verification, remote confirmation, and ancestry checks pass.
- Retain the merge deadline, bounded ten-second observation interval, intervention on timeout/failure, repair budgets, and retained evidence. Queue waiting and closure reconciliation add observations; they are not extra normal-path eligibility checks.
- Recovered old checkpoints may lack a node ID, ordering metadata, or the combined observation. Refresh missing remote facts during recovery rather than guessing an ID or marking a phase complete. The compatibility decision belongs to [#367](https://github.com/BuddyLabsCo/issue-runner-core/issues/367).

## Permissions and response validation

The existing setup can configure separate tracker and code-host tokens. A combined PR/Issue result query needs one credential able to read both surfaces. Do not silently replace the tracker token with the code-host token if it lacks Issue visibility. Reusing one repository credential for those reads is feasible, but the authorization choice is an explicit integration concern.

For fine-grained credentials, plan for repository metadata visibility; Pull requests read/write for PR observation/creation; Contents read/write for refs, Git push and merging; Issues read and, for explicit closure, write; Checks read and Commit statuses read for those observations. GitHub documents endpoint-specific permission requirements for [PR listing/creation and merge](https://docs.github.com/en/rest/pulls/pulls), [Check Runs](https://docs.github.com/en/rest/checks/runs#list-check-runs-for-a-git-reference), and [commit statuses](https://docs.github.com/en/rest/commits/statuses#list-commit-statuses-for-a-reference). These are permissions to provision and test with the chosen token type, not a claim that every individual GraphQL field independently requires every listed permission. Private repository access, organization restrictions, and bypass rights still apply. `adminMerge:true` grants no rights itself.

Use structured request files with `gh api graphql --input <file>` for multiline query/variables or mutation bodies; shell interpolation must not change accepted titles/bodies. Treat GraphQL `errors`, absent required objects/fields, malformed OIDs/dates, unexpected types/state values, and pagination incompleteness as failed observations. Preserve existing redaction and command timeout behavior. A 404 or null at an inaccessible boundary must not erase recorded publication evidence.

Combined queries reduce round trips, not GraphQL node/cost limits or concurrent-change races. Respect retry/backoff signals and distinguish API errors from valid empty results. GitHub can return partial results with errors, and its limits include node and execution budgets; see [GraphQL resource limits](https://docs.github.com/en/graphql/overview/rate-limits-and-query-limits-for-the-graphql-api).

## Decisions surfaced for #367

1. **Budget accounting:** adopt separate acceptance counters for gh invocations, HTTP requests, and Git operations. The agreed normal-path counts are achievable with direct operations; convenience commands alone do not establish HTTP counts.
2. **Completeness exceptions:** preserve exact Q5 matching and required-check semantics by allowing measured pagination exceptions. A hard one-request ceiling for arbitrary histories/check sets has no demonstrated complete API solution. This report does not narrow matching or truncate checks to force the number.
3. **Queue/admin acceptance:** preserve queue-aware dispatch, client policy gates, backend rights, and timeout observations. Two-call Q7 success applies to immediately observable integration/closure, not all queue cases. A queue's configured merge strategy may also override the squash request, as gh currently warns.
4. **Closure and credential acceptance:** retain explicit closure for non-default targets or delayed closure, and ensure the selected read credential can observe both PR and Issue. These exceptions need named acceptance scenarios.
5. **Recovery compatibility:** decide how older persisted progress obtains missing combined metadata and how resumed/repaired work is counted. Keep response-loss reconciliation and local/ancestry validation; do not apply a fresh-run budget by deleting those safeguards.

Suggested later implementation verification covers exact candidate union/deduplication, closed/draft/fork/mismatched-head candidates, pagination, optional failures, mixed Status Contexts and Check Runs, duplicate/retried check runs, empty checks, head movement, `UNKNOWN` versus `CONFLICTING`, admin/queue routing, non-default closure, and lost responses. No runtime tests or production mutations were run for this research; mutation feasibility rests on current schema/docs and pinned CLI source.
