# Code architecture

Public APIs: [integration contract](terminal-contract.md). Build and test commands: [README](../README.md#developing-core).

```text
src/
|-- cli-entry.ts           # Public CLI entry; process, operator and signals.
|-- cli.ts                 # Argument parsing and concrete dependency wiring.
|-- terminal.ts            # Public terminal and enhancement contracts.
|-- config.ts              # Project configuration, validation and init.
|-- config-terminal.ts     # Generic terminal settings and defaults.
|-- run/                   # Issue selection, delivery, review, repairs and cleanup.
|-- agent/                 # Conversation startup, handoffs, recovery and tab lifecycle.
|-- adapters/              # Git/GitHub/terminal I/O and plugin discovery; no workflow policy.
|-- recovery.ts            # Input hash and atomic recovery snapshots.
|-- audit.ts               # Workflow event records.
`-- prompts/               # Load Markdown messages and substitute runtime values.
prompts/                   # Complete Agent messages; keep prompt text out of code.
templates/                 # User-editable configuration and Project prompts.
skills/issue-runner-handoff/ # Handoff protocol.
tests/
|-- agent/                 # Handoff parsing and native identity validation.
|-- run/                   # Workflow, concurrency and recovery scenarios.
|-- adapters/              # External boundaries and real local Git repositories.
|-- support/               # Shared fixtures and private fakes.
|-- fixtures/              # Public consumer and installation fixtures.
|-- package/               # Package verification helpers.
|-- package.test.mjs       # Pack/install and public API checks.
`-- release/               # Release automation checks.
scripts/release/           # Release tooling, outside runtime.
```
