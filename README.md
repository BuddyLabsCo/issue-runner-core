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

Design only. The workflow has not been migrated, no CLI implementation is
included, and no npm package has been published.

The [design document](docs/design.md) records the agreed goals, responsibilities,
file protocols, and open implementation questions.

## Intended usage

The following is a target experience, not an available installation:

```sh
npm install --save-dev issue-runner-core issue-runner-herdr
npx issue-runner run --env herdr
```

Without a prior project installation, the target experience is:

```sh
npx --package=issue-runner-core --package=issue-runner-herdr issue-runner run --env herdr
```

Core supplies the executable and shared behavior. The separately installed
[issue-runner-herdr](https://github.com/BuddyLabsCo/issue-runner-herdr) package
supplies generic Herdr terminal operations. Core has no built-in list of
supported environment names or Agent brands.
