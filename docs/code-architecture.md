# Code architecture

```text
src/
|-- cli-entry.ts           # Public runCli/CliOptions; process, operator and signal ownership.
|-- cli.ts                 # Internal argument parsing, dependency wiring and structured results.
|-- config.ts              # Validate startup; keep init and Project lookup alongside.
|-- config-terminal.ts     # Core-owned generic terminal settings and defaults.
|-- terminal.ts            # Public v2 contracts: opaque control, bound I/O, enhancements.
|-- run/                   # Delivery policy: selection, Batches, Review/fixes, publication,
|                          # repairs, maintenance, verification, cleanup and reports.
|-- agent/                 # Native sessions, Probe, handoff parsing/polling, corrections,
|                          # start/resume and stage tab lifecycle; shared by all purposes.
|-- adapters/              # API/Git/clock/operator I/O and supplied terminal module validation.
|                          # Herdr transport belongs in the plugin repository.
|-- recovery.ts            # Atomic snapshots and input hash; workflow owners restore progress.
|-- audit.ts               # Workflow event recording.
`-- prompts/               # Load built-in Markdown assets for workflow and session owners.
prompts/                   # Built-in stage, Probe and handoff instruction bodies.
templates/                 # User-editable config/prompt defaults for init.
skills/issue-runner-handoff/ # Handoff protocol; task instructions belong in prompts/.
tests/
|-- agent/                 # Handoff parsing contracts without application setup.
|-- run/                   # Complete application scenarios, including recovery.
|-- adapters/              # External boundary checks and real Git tests.
|-- support/               # Shared test fixtures and private dependency fakes.
`-- package/               # Built artifacts installed in isolated global prefixes.
```

- Terminal packages own commands and terminal I/O. Core registers no executable;
  `issue-runner-core/cli` exports only `runCli` and `CliOptions`. Importing it is inert.
  `cli.ts` receives the canonical command identity and validates startup before
  invoking the supplied lazy factory. Core owns generic enhancement configuration and
  lifecycle orchestration. `adapters/enhancement-discovery.ts` verifies the supplied
  terminal installation and loads optional same-prefix modules; CLI wires them into
  the shared Agent workflow. It never initializes enhancement instances. Terminal adapters
  own terminal I/O. CLI accepts the terminal package root and CLI entry identity.
- Dependencies: CLI wires `run/ -> agent/ -> TerminalPlugin`. Use existing
  Tracker/CodeHost/GitWorkspace/Clock/OperatorIO contracts; only entry wiring imports
  concrete adapters.
- `agent/conversation.ts` owns each Runner Tab's startup phases, Assignment,
  cancellation capability, input sequencing, and enhancement cleanup. It receives
  resolved enhancement modules through internal dependencies, never installation paths.
  Preflight and monitoring precede command submission; readiness and native identity
  validation precede task dispatch. Missing modules use the base delay and Probe.
- Enhancements receive the adapter's unchanged bound I/O and a separate recovery
  callback. Core retains Assignment IDs, expected files, and recovery wording.
  Assignment changes and accepted recovery share a per-tab queue through actual
  adapter submission. Stale recovery succeeds without input.
- `agent/stage.ts` owns prompts, handoff validation, exact native resume validation,
  and generic Operator Pause on readiness rejection. Retry retains completed startup.
  Cancellation or terminal failure revokes automatic I/O before cleanup; failed
  cleanup retains the interactive tab. Late factories transfer instances only for
  cleanup. Successful cleanup is idempotent, failed cleanup is retryable, and
  cleanup failures are reported separately from operational failures.
- `run/` owns acceptance and remote mutations; `agent/` owns conversation mechanics.
  Adapters provide operations and facts, not workflow decisions.
- `run/documentation.ts` owns Maintenance Ticket occurrences and their
  recovery scope. It reuses `run/standalone.ts` for document execution and normal
  publication/integration, with no business-Issue selection or ordinary Review.
  `run/execution-recovery.ts` validates saved execution context before continuation
  or documentation cleanup and owns explicit Issue restart after recovery failure.
  `run/integration.ts` also owns verified no-change closure.
- `run/cleanup.ts` removes successfully delivered execution resources for ordinary
  Issues and documentation. It validates ownership and checkpoints completed actions
  so recovery retries unfinished Worktree/branch and handoff-file cleanup.
- `run/batch.ts` owns Batch execution and the successful-delivery documentation
  trigger. `run/discovery.ts` persists the Batch's maintenance association before
  document work starts. `run/run.ts` restores pending Batch barriers before discovery;
  `run/documentation.ts` reuses the document workflow for each associated occurrence.
- `run/review.ts` owns Review rounds, fix verification, accumulated commits, and
  findings cleanup. `agent/stage.ts` shares Probe, native role resume, handoff
  corrections, and tab lifecycle across implementation, Review, and fixes.
- `run/report.ts` records ordered per-Issue outcomes and PR/resource details through
  execution and deferred integration, including retained-resource reports.
  `run/run.ts` preserves those reports on failure or cancellation; CLI renders the results.
- Business logic, including `run/` and `agent/`, must be OS- and coding-agent-agnostic:
  no platform or agent-brand branches, commands or imports. Keep platform details in
  adapters/plugins and agent-specific start/resume commands in configuration.
- `recovery.ts` owns persistence and the shared input hash. CLI supplies the canonical
  command name, exact argument array, and validated configuration bytes once;
  execution, Batch, and maintenance checkpoints and associations reuse that hash.
  Command renames isolate progress; command/Core versions and installation paths
  do not affect it. `run/` and `agent/` own restored behavior, including explicit
  restart and retention of unfinished resources.
- Keep helpers in their owning module; extract shared code only for actual callers.
- Built-in Markdown templates own complete Agent messages, including headings,
  context labels, project-instruction placement, and handoff instructions. Code
  loads templates and substitutes values once; it does not append prompt text.
