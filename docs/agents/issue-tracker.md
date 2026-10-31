# Issue tracker: GitHub

Issues and specs live in `BuddyLabsCo/issue-runner-core`. Use the `gh` CLI
from this clone. Before the first issue creation of a session, verify the
target with `gh repo view --json nameWithOwner`.

## Operations

- Create: `gh issue create --title "..." --body-file <file>`.
- Read: `gh issue view <number> --json number,title,body,labels,comments`.
- List: `gh issue list --state open --json number,title,body,labels`.
- Create a sub-issue: `gh issue create --parent <parent> --title "..." --body-file <file>`.
- Link an existing child: `gh issue edit <parent> --add-sub-issue <child>`.
- Record a blocker: `gh issue edit <child> --add-blocked-by <blocker>`.
- Apply or remove labels: `gh issue edit <number> --add-label "..."` or `--remove-label "..."`.
- Comment: `gh issue comment <number> --body-file <file>`.
- Close: post the explanation as a comment, then run `gh issue close <number>`.

When a skill says "publish to the issue tracker", create a GitHub issue.
When it says "fetch the relevant ticket", read the GitHub issue.

## E2E test issues

### Case and fixture setup

Create one `e2e-epic` acceptance issue per test case per platform in this
repository. Maintain separate Windows and Linux sets, with platform names in
the titles, such as `[E2E][Windows] --parent normal workflow`. Each issue states
its prerequisites, configuration, steps, expected results, and required evidence.

Create fixture issues as native sub-issues of the acceptance issue and label
them `e2e-test`. Fixtures describe small executable requirements, such as
editing documentation text; the acceptance issue describes how to run the test.
Use separate fixtures for each platform's case so their PRs and issue state are
independent.

- For a normal `--parent` case, create five fixture sub-issues and run Runner
  with the acceptance issue as the selected parent.
- For a standalone Issue case, create one fixture sub-issue and select that
  issue directly, without `--parent`. Its tracker parent only groups test data.
- Create separate acceptance issues for other cases, such as interruption and
  recovery, with the fixtures needed for that case.

Read `docs/agents/triage-labels.md` before applying labels.

### Test branch and execution

When execution of an acceptance issue starts, create and push
`e2e-test-<issue-number>` from the latest fetched `main`, where the number is
that acceptance issue's number. Record the starting commit on the issue.
Create the branch at test start, rather than when planning or creating tickets.
When continuing an interrupted test, reuse its branch and recorded progress.

Configure Runner to use this branch as the base for the fixture work. Every
fixture PR must target `e2e-test-<issue-number>`, and test integrations go into
that branch. Keep fixture changes isolated from `main`. Each acceptance issue
has its own branch, including the Windows and Linux versions of the same case.

The testing agent executes the documented case and records:

- Package versions or tarball identities, OS, Node/npm versions, Herdr version,
  Agent CLI configuration, and relevant Runner configuration.
- Commands, test branch and starting commit, fixture/PR links, and actual
  results against each expected result.
- Supporting evidence, including relevant audit/recovery records, handoff
  files, Git state, and observed terminal behavior.

For interruption/restart cases, record the interruption point and state before
and after rerunning Runner. Before the rerun, the operator must manually close
all leftover Agent tabs and stop all associated AI sessions. Retain their
native conversation history and original working resources. Runner assumes
this is done; it does not enforce it or adopt surviving live tabs.

Keep Run arguments and `config.yaml` unchanged when testing recovery. For the
config-change case, keep arguments unchanged and modify `config.yaml` so the
combined input hash differs: expect a new Run that ignores old persisted
progress, rather than recovery. Existing remote-state reconciliation and
retention of interrupted resources still apply.

Check fixture PR bases, integration, issue closure, and case-specific cleanup
or retention explicitly. An acceptance issue passes only when its expected
results have evidence; report failures and unexecuted steps before closing it.
Fixture completion alone does not establish acceptance.

### Discovered defects

On the first discovered bug, create a separate defect epic for that acceptance
issue, label it `bug-epic`, and link it from the acceptance issue. Create one bug
issue per distinct problem as a native sub-issue of that epic; reuse the epic
for further bugs from the case.

Each bug includes reproduction steps, expected and actual behavior, available
evidence, and links to the acceptance issue and affected fixtures/PRs. Link the
bug from the acceptance issue's results. Discovered bugs belong under the defect
epic; the acceptance issue's own children are test fixtures. Keep the defect
epic outside the fixture hierarchy so `--parent` discovery selects test work.

## Pull requests as a triage surface

**PRs as a request surface: no.**

## Pull requests

- **Title** — follows the Conventional Commits spec in the form
  `<type>: [issue-<issue-number>] <subject>`, for example `fix: [issue-42] correct retry backoff`.
- **Description** — must end with `Closes #<issue-number>`
