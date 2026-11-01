# Test ownership

Run `npm test` for all tests, or `npm run verify` to include formatting, lint, and type checks. Files run in separate processes with concurrency capped at four; tests within each file remain sequential. Temporary projects and Git repositories belong to each test.

| Command | Responsibility |
| --- | --- |
| `npm run test:workflow` | Handoff parsing and application workflows, including recovery |
| `npm run test:adapters` | Real Git and scripted GitHub command boundaries |
| `npm run test:package` | Build, pack, install, public types, CLI shims, plugin resolution, bundled assets |
| `npm run check` | Formatting, lint, and TypeScript |

`npm test` also includes architecture-rule checks. CI runs every behavioral suite on Linux and Windows. Static checks run once on Linux. Package tests invoke `prepack`; no separate build is needed before testing.

## Coverage map

| Files | Owned behavior |
| --- | --- |
| `agent/handoff.test.ts` | Execution and Review JSON validation, accepted results, assigned findings paths |
| `run/cli-startup*`, `cli-validation*` | Argument/config validation, initialization, real process entry and EOF |
| `run/cli-implementation*`, `cli-prompt-assembly*` | Reservation through implementation, startup/Probe/task submissions, native resume |
| `run/cli-handoff*`, `cli-correction-budget-recovery*` | Observation, correction, atomic publication, persisted budgets and interrupted acceptance |
| `run/cli-review*` | Review rounds, findings files, fixes, Git verification and role-specific recovery |
| `run/cli-parent*`, `cli-empty-parent*`, `cli-issue-list*` | Discovery, eligibility, pagination, selection, reservations and parent closure |
| `run/cli-batch*` | Concurrent dispatch, pauses, delivery barriers, maintenance association and Batch recovery |
| `run/cli-publication*`, `cli-integration*` | Push/PR intent, uncertain responses, checks, merge queues, observed delivery and recovery |
| `run/cli-ci-repair*`, `cli-conflict-repair*`, `cli-repair*` | Repair ownership, independent budgets, remote advancement, interrupted push and recovery |
| `run/cli-documentation*` | Maintenance occurrences, no-change closure, continuation and recovery scope |
| `run/cli-cancellation*`, `cli-operation-recovery*`, `cli-recovery*` | Interruptible operations, persisted retry state, atomic checkpoints and explicit restart |
| `run/cli-cleanup*`, `cli-retention*`, `cli-reporting*` | Owned-resource deletion, interrupted cleanup, retained work and outcome reports |
| `run/full-contract*` | Composed multi-Issue success, failure and recovery across workflow boundaries |
| `adapters/*-git*`, `adapters/cli-worktree-paths*` | Real commits, ancestry, dirty work, isolated configuration and path aliases |
| `adapters/*-host*` | GitHub command arguments and response interpretation |
| `package.test.mjs`, `package/` | Installed consumer and global package contracts |
| `static-checks.test.mjs` | Project architecture restrictions |

## Consolidation decisions

- Move ten execution schema cases to the parser boundary. Keep correction dispatch, fresh assignments, exhausted budgets and manual recovery in workflow tests.
- Move Review schema variants to parser tests. Keep wrong-path correction as the integration example, plus missing/empty/directory reports and actual Git violations.
- Remove five duplicate Git-mismatch rejection runs. The actionable-correction matrix still checks each mismatch before accepting corrected evidence.
- Merge startup cancellation into the unresolved-wait cancellation matrix, including removal of temporary Git configuration.
- Remove the duplicate correction-cancellation case. The cancellation matrix and matching-rerun test cover both interruption and retained budget.
- Keep no-change reporting and its completed checkpoint in one scenario. Keep identical handoff republication in the observation suite.
- Remove the legacy-field correction scenario duplicated by schema, assignment-history and superseded-file tests.
- Remove two Batch variants that added 3.2 seconds each without changing operation ordering. Both parent and Issue List selectors retain checkpoint and merge-barrier assertions.
- Run prompt sequencing through source once. Package tests retain prompt loading, byte equality, missing-asset failure and executable checks instead of replaying both source workflow helpers.
- Remove the test of ESLint's built-in line-count implementation. Keep the configured limit and tests of this project's architecture restrictions.

Recovery tests remain when they interrupt different persisted phases or remote effects. Similar setup alone does not make them redundant: resuming a pending push, a confirmed merge, or unfinished cleanup has different replay and data-loss risks.

## Test-by-test audit and validation

The [audit ledger](../docs/testing-audit.md) records a decision for each of the previous 556 runtime test entries, including every parameterized variant. It names the surviving coverage for each removed or merged entry.

The second pass removed or absorbed 53 entries and introduced two consolidated scenarios, leaving 505. It merged reporting and checkpoint assertions into existing workflows, removed duplicated recovery paths, and reduced repeated eligibility matrices at shared call sites. It also removed exact-prose tests and checks of external tooling behavior.

`npm run verify` passed on Linux with Node 22.18.0 and npm 11.6.2: 504 tests passed, one existing platform test skipped, zero failures. The test run took 30.8 seconds, compared with 35.5 seconds after the first pass and 117.1 seconds originally. These are local samples, not hosted CI timings. Windows CI remains enabled and was not executed locally.

## Adding tests

Put input-shape matrices at the narrowest existing function boundary. Keep a representative workflow test proving rejection prevents dispatch or publication and recovery still works. Add real Git coverage for behavior fakes cannot establish; add package coverage for installation and resolution. Avoid copying a workflow into every layer or asserting incidental prose. Use controlled clocks or explicit gates instead of real delays.
