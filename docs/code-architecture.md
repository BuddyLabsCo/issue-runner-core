# Code architecture

```text
src/
|-- cli.ts                 # Parse arguments, wire dependencies, return exit status.
|-- config.ts              # Validate startup; keep init and Project lookup alongside.
|-- terminal.ts            # Public v1 contract: createTab, submitText, closeTab.
|-- run/                   # Delivery policy: selection, Batches, Review/fixes, publication,
|                          # repairs, maintenance, verification, cleanup and reports.
|-- agent/                 # Native sessions, Probe, handoff parsing/polling, corrections,
|                          # start/resume and stage tab lifecycle; shared by all purposes.
|-- adapters/              # API/Git/clock/operator I/O and selected global plugin loading.
|                          # Herdr transport belongs in the plugin repository.
|-- recovery.ts            # Atomic snapshots and input hash; workflow owners restore progress.
|-- audit.ts               # Workflow event recording.
`-- prompts/               # Built-in purpose instructions and explicit handoff invocation.
templates/                 # User-editable config/prompt defaults for init.
skills/issue-runner-handoff/ # Handoff protocol; task instructions belong in prompts/.
tests/
|-- run/                   # Complete application scenarios, including recovery.
|-- adapters/              # External boundary checks and real Git tests.
|-- support/               # Shared test fixtures and private dependency fakes.
`-- package/               # Built artifacts installed in isolated global prefixes.
```

- Dependencies: CLI wires `run/ -> agent/ -> TerminalPlugin`. Use existing
  Tracker/CodeHost/GitWorkspace/Clock/OperatorIO contracts; only entry wiring imports
  concrete adapters.
- `run/` owns acceptance and remote mutations; `agent/` owns conversation mechanics.
  Adapters provide operations and facts, not workflow decisions.
- Business logic, including `run/` and `agent/`, must be OS- and coding-agent-agnostic:
  no platform or agent-brand branches, commands or imports. Keep platform details in
  adapters/plugins and agent-specific start/resume commands in configuration.
- `recovery.ts` owns persistence; `run/` and `agent/` own restored behavior.
- Keep helpers in their owning module; extract shared code only for actual callers.
