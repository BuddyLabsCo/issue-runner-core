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

## Module ownership

Keep policy with its workflow owner and external operations with adapters:

| Concern | Owner | Boundary |
| --- | --- | --- |
| Process and CLI | `cli-entry.ts`, `cli.ts` | Command identity, signals/operator, validation and lazy dependency assembly; no Core executable |
| Configuration | `config.ts`, `config-terminal.ts` | Project/init, credential/prompt validation, generic defaults; adapter-owned options remain opaque |
| Delivery workflow | `run/run.ts`, `discovery.ts`, `batch.ts`, `standalone.ts` | Scope, Reservations, eligibility, Batch membership, concurrency and acceptance barriers |
| Review, publication, integration | `run/review.ts`, `publication.ts`, `integration.ts`, `repair.ts` | Verify local/remote facts before crediting delivery; own remote mutations and repair budgets |
| Documentation | `run/documentation.ts` | Maintenance Ticket occurrences, Batch associations, continuation and cleanup scope; reuse standalone execution without business selection or ordinary Review |
| Session coordination | `agent/conversation.ts`, `stage.ts` | Per-tab startup, readiness retry, exact native identity, Probe/handoff corrections, Assignment/recovery queue and capability revocation |
| Public interfaces | `terminal.ts`, `cli-entry.ts` | Supported plugin/CLI contracts; keep implementation and testing entries private |
| External operations | `adapters/`, `run/contracts.ts` | API/Git/clock/operator operations and facts; no workflow decisions in adapters |
| Enhancement discovery | `adapters/enhancement-discovery.ts`, CLI | Validate executing terminal installation; resolve optional same-prefix modules; never initialize instances |
| Recovery persistence | `recovery.ts` | Atomic snapshots and shared hash of canonical command name, exact args, validated config bytes; versions and installation paths excluded |
| Restored behavior | `run/`, `agent/`, `run/execution-recovery.ts` | Revalidate saved ownership/context, resume exact native refs, preserve unfinished resources, explicitly restart unrecoverable Issues |
| Audit | `audit.ts`, operation owners | Record workflow facts; retry failed logging without replaying completed external operations |
| Cleanup and reporting | `run/cleanup.ts`, `review.ts`, `report.ts`, `agent/conversation.ts` | Checkpoint owned-resource removal; findings belong to Review; enhancement cleanup precedes owned-tab closure; retain/report failed and unfinished resources |
