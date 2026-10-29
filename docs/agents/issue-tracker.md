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

An issue labelled `e2e-test` describes an end-to-end test task for an AI agent.

The agent executes the tests described in the issue and records the steps,
results, and supporting evidence on that issue.

Create a separate issue for each distinct problem discovered. Include
reproduction steps, expected behavior, actual behavior, and available evidence.
Link each problem as a native GitHub sub-issue of the `e2e-test` issue using
`--parent`, or `--add-sub-issue` for an existing issue.

Read `docs/agents/triage-labels.md` before applying labels.

## Pull requests as a triage surface

**PRs as a request surface: no.**

## Pull requests

- **Title** — follows the Conventional Commits spec in the form
  `<type>: [issue-<issue-number>] <subject>`, for example `fix: [issue-42] correct retry backoff`.
- **Description** — must end with `Closes #<issue-number>`
