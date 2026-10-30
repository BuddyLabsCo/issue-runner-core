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

The accepted [handoff skill](skills/issue-runner-handoff/SKILL.md) is available
for manual installation. The workflow has not been migrated, no CLI
implementation is included, and no npm package has been published.

The [design document](docs/design.md) records the agreed goals, responsibilities,
file protocols, and open implementation questions.

## Intended usage

The following is a target experience, not an available installation:

```sh
npm install --global issue-runner-core issue-runner-herdr
issue-runner run --env herdr
```

Core and the selected terminal plugin must share the same active npm global
installation environment. Project configuration stays in the selected
Project's `config.yaml`.

Core supplies the executable and shared behavior. The separately installed
[issue-runner-herdr](https://github.com/BuddyLabsCo/issue-runner-herdr) package
supplies generic Herdr terminal operations. Core has no built-in list of
supported environment names or Agent brands.

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

## Verify the repository skill

With Node.js available, run the focused asset check:

```sh
node --test tests/issue-runner-handoff.test.mjs
```

Run all repository tests with `node --test`. The asset check compares the
skill's SHA-256 against the exact accepted Markdown, normalizing only CRLF
to LF for cross-platform checkouts. It requires no Agent account, model call,
or Herdr installation. Packaged-installation verification and real Agent
execution remain separate acceptance work.
