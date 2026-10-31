# issue-runner-core

Shared issue delivery workflow and the `issue-runner` CLI, with independently
installed terminal execution environment plugins.

The project will reuse the workflow behavior of
[sandcastle-runner](https://github.com/BuddyLabsCo/sandcastle-runner), excluding
Agent-session Operator Pause and Runner-recorded Agent conversation logs.
Interactive Agent CLIs run in terminals owned by the selected environment,
where operators can intervene directly. Native session references and task
results return through file handoffs.

## Status

The development package includes the single `issue-runner` executable,
help/version/init, strict Project and Run-scope validation, global terminal
plugin loading, and an empty-parent Run that returns `no_work` without closing
the parent. It exports the runtime constant and TypeScript declarations at
`issue-runner-core/terminal`. The accepted
[handoff skill](skills/issue-runner-handoff/SKILL.md) is available for manual
installation and is included in the tarball. A numbered standalone `--issue`
can reserve eligible work, create a fresh Target Branch Worktree, start a native
implementation conversation, and persist its independently verified local
completion before closing the owned tab. Enabled Review starts an independent
reviewer, verifies its report and unchanged Git state, and resumes the original
implementation conversation for every findings round. Later Reviews resume the
original reviewer. The final allowed findings round also receives a verified fix.
Runner pushes the verified HEAD and creates a non-draft PR using the fixed Probe
title and body. It waits 30 seconds before discovering required checks.
Failed required checks start a fresh CI-repair conversation and Worktree, verify
the repair, and push to the same remote branch and PR. Two consumed CI attempts
require operator authorization before another generation. Repair progress and
pending pushes survive matching-input recovery.
With `--no-auto-merge`, CI-ready PRs, branches, Worktrees, handoffs, and progress
evidence remain available. Unmerged work reports `incomplete` without successful
delivery credit or success cleanup. Auto-merge requests squash integration against
the observed HEAD and confirms both merge completion and tracker `closed/completed`
before granting delivery credit. Checkpoints retain those facts and exact delivery-time labels.
Conflict repair and success cleanup remain downstream. Initial
`no_change` skips Review and publication and also reports `incomplete`.
Parent Runs select eligible direct children across all child/blocker pages,
respect Issue List filtering and Reservation ownership, and execute one
configured Batch concurrently through publication and CI, bounded by `maxBatchSize`.
Every Batch PR must be CI-ready before serial integration by creation time and PR number.
Batch membership is checkpointed before dispatch and retained
on recovery. A value-less `--issue` selects the configured Issue List
independently of parent discovery, using the same eligibility checks and
publication, CI barrier, and integration workflow. Standalone documentation remains unimplemented.
No npm package has been published.

Non-Agent failures retain bounded safe retries and Operator Pause. Enter retries;
`q` or EOF cancels. Issue-scoped pauses also allow `s` to skip that Issue while
retaining its resources. Resource creation requires an explicit retry; uncertain
prompt delivery stops without replay. Audit recovery retries only logging.
See [non-Agent recovery](docs/configuration.md#non-agent-recovery) for the operation policies.

See [terminal contract development](docs/terminal-contract.md) for the public
API, build/test commands, tarball identity, and independent plugin consumption.
The accepted [Core specification](https://github.com/BuddyLabsCo/issue-runner-core/issues/45)
and its linked final decisions supersede the earlier
[design document](docs/design.md), including its local/npx installation examples.

## Development usage

Install built Core and plugin tarballs globally in the same active npm
environment. The package names below describe the eventual registry install:

```sh
npm install -g issue-runner-core issue-runner-herdr
issue-runner init --project my-project
# Edit my-project/config.yaml and the three prompts, then set its credentials.
issue-runner run --project my-project --env herdr --parent 42
# For one eligible standalone Issue, run implementation and enabled Review/fixes:
issue-runner run --project my-project --env herdr --issue 123
# For the standalone Issue List, set issueList in config.yaml, then run:
issue-runner run --project my-project --env herdr --issue
```

Core supplies the executable and shared behavior. The separately installed
[issue-runner-herdr](https://github.com/BuddyLabsCo/issue-runner-herdr) package
supplies generic Herdr terminal operations. Core has no built-in list of
supported environment names or Agent brands. Install both in the same active
npm global environment/prefix. The initial baseline is Node.js 22.18 or later
within 22.x and npm 11.x. Project configuration stays in the selected
Project's `config.yaml`.

See [configuration and startup](docs/configuration.md) for supported options,
validation, current scope, and test limits. `init` refuses existing destinations,
requires no credentials, and does not install a plugin or an Agent skill.

## Install the handoff skill manually

Install `issue-runner-handoff` in each Agent CLI used for implementation,
Review, or documentation before running Runner:

1. Locate the Agent CLI's documented user skill directory.
2. Copy the repository's entire `skills/issue-runner-handoff` directory there,
   unchanged. The installed file must be
   `<agent-skills-directory>/issue-runner-handoff/SKILL.md`.
3. Reload skills or restart the Agent CLI as its documentation requires, and
   verify that `issue-runner-handoff` is available for explicit invocation.

Runner does not install the skill automatically. Use an Agent CLI that supports
the skill's explicit-only invocation metadata.

## Invoke or correct a handoff

Runner's task prompts explicitly name `issue-runner-handoff` and supply one
argument: the assigned absolute final JSON output path. Runner displays that
path with the current stage and actual native session identity.

In that native Agent conversation, explicitly invoke the installed skill with
the displayed path, using the Agent CLI's skill invocation syntax. For a CLI
with slash-command skills, examples are:

```text
/issue-runner-handoff /absolute/runner/project/handoffs/123-implement-20261029T120000000Z.json
/issue-runner-handoff "D:\Runner Work\project\handoffs\123-implement-20261029T120000000Z.json"
```

Each example passes a single output path; it is not an instructions-document
path. Use the current assigned path verbatim. If handoff instructions were
forgotten or that same invocation needs correction, reinvoke the skill in the
original conversation with that same path. It validates and closes the
temporary sibling `<handoff-path>.tmp`, then atomically replaces the final
file as its last step. A different invocation, automatic correction, or retry
gets a fresh Runner-assigned path.

The skill's [accepted content](https://github.com/BuddyLabsCo/issue-runner-core/issues/5#issuecomment-6497094791)
defines exactly `outcome`, `summary`, `commits`, and `findings_file`. Execution
uses `committed` or `no_change`; Review uses `passed` or `findings`. Commit
entries contain full Git SHAs and messages. Purpose-specific prompts define
task completion, required checks and commits, Review write restrictions,
post-handoff work restrictions, and remote-operation ownership. Runner owns
push, PR, integration, and tracker operations. The skill only submits the
handoff; submission alone does not establish successful delivery.

Numbered Issue Runs display `sessionid=pending`, then the Probe-validated native
identity and the active handoff path. Commands use Enter; after one 10-second
startup wait, Probe and task use the configured Agent chord as separate
submissions. Approvals, questions, native errors, and missing output require
direct handling in that native conversation. Runner sends no missing-output
reminders. Invalid results get specific corrections in the same tab at new paths,
without another startup wait. `agentRetry` allows additional corrections;
`agentRetryDelay` is in seconds and reuses its final delay. After exhaustion,
fix the reported problem and manually invoke the skill at the current displayed
path. Runner keeps watching that path; further invalid writes do not restore
automatic attempts. See [correction behavior](docs/configuration.md#rejected-handoffs-and-manual-correction).

Recovery Snapshots retain role identity, fixed Probe PR metadata, invocation,
Worktree/branch/base, consumed correction count, accepted commits, and stage
completion under the Project's `recovery/`. Matching arguments and configuration
can continue assigned implementation, Review, and fixes using each role's exact
saved native reference. Review round/base/HEAD, assigned findings, per-stage
correction budgets, and accepted fix commits are retained. Findings stay available
through the loop and are deleted after the complete Review/fix loop; Probe and
handoff files remain until successful Issue cleanup.
A known unsent assignment or correction remains pending when eligibility stops
dispatch and is submitted when eligibility returns, retaining its path and consumed
retry count. Missing output from an attempted assignment resumes with only
`continue`. Before rerunning, manually close
leftover tabs and stop their Agent sessions, retaining native history and working
resources. Runner does not adopt live tabs. Incomplete earlier startup checkpoints
are retained and reported as unrecoverable; whole-Issue restart interaction and
broader workflow recovery remain downstream. Changed input ignores old snapshots
and never adopts unrelated Reservations. Local completion retains owned files
and Worktrees for later workflow steps.

## Development checks

Run `npm ci`, then `npm run verify` for formatting, lint, type checks and tests.
Use `npm run format` to apply code formatting and `npm run check` for static checks
only. CI runs the build and verification on Ubuntu and Windows.

ESLint limits code files to 500 lines, excluding blank lines and comments.
Business modules reject concrete adapter/known Agent SDK imports, direct platform
access and dynamic loading. These checks support the
[architecture boundaries](docs/code-architecture.md); they do not replace review.

## Verify the repository skill

With Node.js available, run the focused asset check:

```sh
node --test tests/issue-runner-handoff.test.mjs
```

Run `npm ci` and then `npm test` for all repository tests. The asset check
compares the skill's SHA-256 against the exact accepted Markdown, normalizing
only CRLF to LF for cross-platform checkouts. It requires no Agent account,
model call, or Herdr installation. Packaged-installation verification and real
Agent execution remain separate acceptance work.
