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

The minimal terminal-contract package is available for local development.
It exports the runtime constant and TypeScript declarations at
`issue-runner-core/terminal`. The workflow has not been migrated, no CLI
implementation is included, and no npm package has been published.

See [terminal contract development](docs/terminal-contract.md) for the public
API, build/test commands, tarball identity, and independent plugin consumption.
The accepted [Core specification](https://github.com/BuddyLabsCo/issue-runner-core/issues/45)
and its linked final decisions supersede the earlier
[design document](docs/design.md), including its local/npx installation examples.

## Intended usage

The following is a target experience, not an available installation:

```sh
npm install -g issue-runner-core issue-runner-herdr
issue-runner run --env herdr
```

Core supplies the executable and shared behavior. The separately installed
[issue-runner-herdr](https://github.com/BuddyLabsCo/issue-runner-herdr) package
supplies generic Herdr terminal operations. Core has no built-in list of
supported environment names or Agent brands. Install both in the same active
npm global environment/prefix. The initial baseline is Node.js 22.18 or later
within 22.x and npm 11.x.
