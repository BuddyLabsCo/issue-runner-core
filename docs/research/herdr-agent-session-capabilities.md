# Herdr Agent session capabilities (Wayfinder Q7)

Research date: 2026-11-27. Installed Herdr: 0.9.5, socket protocol 22, schema version 1. The [latest stable release](https://github.com/herdrdev/herdr/releases/latest) resolves to [v0.9.5](https://github.com/herdrdev/herdr/releases/tag/v0.9.5) (commit 2ecf19a). This note uses the installed binary's help and bundled schema, release-tagged source, and official documentation. The website can describe development ahead of the release; the tagged source and installed schema take precedence. No live Agent or Herdr session was created.

## Decision

This section records the research recommendation. The approved [public integration contract](../terminal-contract.md) retains the common Session Probe in Core rather than moving it into each Adapter.

Herdr is more than a terminal adapter: it recognizes Agents, offers a managed startup wait, receives provider-native session references, and attempts native conversation restore. It cannot, on its own, guarantee all three properties required by Runner: readiness for the first Assignment, the actual persistent Native Session Reference, and verified recovery of that exact conversation.

| Capability | Herdr 0.9.5 | Implication for Q7 |
| --- | --- | --- |
| Agent readiness | Managed launch waits for detected interactive readiness; provider-specific state may be inferred from terminal output. | Better than a fixed startup delay, not a universal native readiness acknowledgment. |
| Native Session Reference | Optional provider ID or path, typically supplied by an integration; may instead be seeded from Codex resume arguments. | Do not persist an absent, stale, misrouted, or merely requested reference as proof of identity. |
| Exact resume | Provider-specific resume invocation using a saved reference. | Validate the actual conversation after opening it; launching the requested command is not verification. |
| Assignment monitoring | State-based waits and socket events. | Useful for observing interruptions and readiness, not proof an Assignment completed. |

Recommend a uniform Agent Session boundary on the Adapter side, with Core owning stage sequencing, persisted references and exact-identity checks. An Adapter that passes the contract may use its native APIs, integrations, or a Probe fallback internally. Do not delete the fallback simply because Herdr has Agent-aware APIs. Keep the current Core fallback until the replacement Adapter contract, including fallback and failure behavior, is implemented. If an Adapter cannot establish identity, fail or pause rather than guessing a conversation.

## Existing local contract

- [GLOSSARY.md](../../GLOSSARY.md) distinguishes Core's Agent Session from its Native Session Reference.
- [Original terminal contract](https://github.com/BuddyLabsCo/issue-runner-core/blob/2fb5a82088f2ea5e207f9b237dd3755ced754be4/docs/terminal-contract.md): `execute` may return a native reference or nothing. An enhancement starts monitoring before launch and returns the actual reference from `waitUntilReady`.
- [Core conversation readiness](../../src/agent/conversation.ts#L140-L188) uses the enhancement when present; otherwise it waits the configured delay and takes the optional execute result. [Stage workflow](../../src/agent/stage.ts#L147-L304) validates the reference, persists it, and obtains it through a Probe when unavailable. The returned identity on resume must match the expected reference if one is returned.
- [Herdr adapter operations](../../../issue-runner-herdr/src/plugin/operations.ts#L64-L119): owns handles to workspace/tab/pane/terminal targets; `execute` submits the opaque shell command and returns no reference. Bound I/O reads and writes the pane. It does not use the managed Agent launch, session identity or lifecycle APIs. [Target validation](../../../issue-runner-herdr/src/herdr/targets.ts#L34-L58) checks Herdr's routing IDs, not provider sessions.
- [T3 adapter](../../../issue-runner-t3/src/terminal.ts#L314-L360): starts an idle native T3 thread, validates its launch receipt and returns its thread ID. [Resume](../../../issue-runner-t3/src/terminal.ts#L153-L193) reads the requested thread, validates project/worktree/inactive status and queue state, and binds the same ID. This is the T3 contract Runner uses; it does not require Core to reconstruct a provider session from terminal output.

A Herdr session (named multiplexer/server instance), pane ID, terminal ID and live Agent name are routing or presentation identifiers. None identifies a provider conversation. Agent names are cleared on process exit/replacement; pane IDs can change when moved. A terminal can host successive conversations. See [Agent automation](https://herdr.dev/tui/docs/agent-automation/#agent-identity-and-launch).

## Readiness and observation

The installed `herdr agent start --help` documents a launch into an existing shell pane:

```text
herdr agent start NAME --kind KIND --pane ID [--timeout MS] -- [AGENT_ARG...]
```

The default timeout is 30 seconds and the maximum is 300 seconds; the documented minimum is strictly greater than 3 seconds. The command launches the canonical executable, preserving supplied arguments. Startup can fail on a timeout or a blocked prompt. It does not create layout or wait for a Native Session Reference.

The installed `herdr api schema --json` confirms:

- `agent.start` returns `agent_started` with `agent` and `argv`.
- `agent.get` and `agent.list` expose `AgentInfo`: terminal/pane routing, provider label, state, optional `interactive_ready`, `launch_pending`, `screen_detection_skipped`, state/completion sequence fields, and optional nullable `agent_session`.
- `pane.get` and `pane.list` include the optional nullable session field as well.
- `agent.wait` waits for states such as idle, working, blocked, done or unknown, with a caller-supplied timeout. Waiting for idle alone is not the same as waiting for an identity.
- `agent.prompt --wait` (installed help) rejects an already blocked Agent, requires observed progress after submission from a non-working state, and then waits for a matching state. It does not correlate provider turns; an already active turn can satisfy the wait.

Ordinary Agents are detected using process identification and screen manifests. For supported lifecycle integrations, the Agent's own reports take precedence while authoritative. [Tagged state arbitration](https://github.com/herdrdev/herdr/blob/v0.9.5/src/terminal/state.rs#L2131-L2176) shows managed startup accepts the expected Agent in idle state, and even accepts Codex in unknown state if a prompt has been detected. These are Herdr's readiness rules, not a provider-native acknowledgment of conversation creation.

The raw socket supports `events.subscribe`, including pane updates, detection, status changes, exits and closure; the installed schema includes these event types and state waits. Integrations can send lifecycle reports through `pane.report_agent` and identity through `pane.report_agent_session`. Those are distinct operations. A reported change need not change the state from idle to working; observe pane updates and reconcile identity separately.

A subscription avoids external screen scraping or repeated status polling in normal operation, but events can originate from Herdr's own screen detection rather than the provider. Subscription history is finite and not durable. Subscribe before launch, reconcile via `agent.get` or `session.snapshot`, and resubscribe/re-read on disconnect or events lost. Bounded polling of authoritative reads is a simpler alternative when an event stream is unnecessary. See [Socket API: event subscriptions](https://herdr.dev/tui/docs/socket-api/#event-subscriptions) and [Agent states](https://herdr.dev/tui/docs/agents/#how-status-works).

## Provider-specific capabilities

The installed launch command recognizes 24 kinds; launch support is broader than native restore support. [Tagged resume planner](https://github.com/herdrdev/herdr/blob/v0.9.5/src/agent_resume.rs#L186-L303) and [integration documentation](https://herdr.dev/tui/docs/integrations/#how-herdr-uses-integrations) establish these categories:

| Provider | State with official integration | Native resume invocation |
| --- | --- | --- |
| Codex | Screen detection; identity through SessionStart | `codex resume ID` |
| Claude Code | Screen detection; identity through SessionStart | `claude --resume ID` |
| Pi / OMP | Lifecycle and identity reports | `pi --session REF` / `omp --resume=REF` (path or ID) |
| OpenCode / Kilo / Kimi / MastraCode | Lifecycle and identity reports | `opencode --session ID`, `kilo --session ID`, `kimi --session ID`, `mastracode --thread ID` |
| Copilot / Devin / Droid / Cursor / Grok / Hermes / Qoder / Qwen | Screen detection; identity integration | Provider-specific resume flag, using ID |
| Antigravity / Letta | Screen detection; identity integration | Provider-specific conversation flag, using ID |
| Amp / Gemini / Cline / Maki | State detection; no official native restore in the tagged planner | None through that planner |

Kiro, Muse and other self-integrating Agents may report their own lifecycle and resume argv. A resume command alone does not guarantee a stable provider ID (it could select the most recent session). Require an independently verified reference if supporting these Agents. The installed report-agent help, [socket reporting reference](https://herdr.dev/tui/docs/socket-api/#agent-state-reporting), and [official integration guide](https://herdr.dev/tui/docs/agents/#supported-agents) describe these two approaches. Other Agents can still run as ordinary terminal processes.

Integration installation and version matter independently of the Herdr version. Check `herdr integration status` during preflight and validate the actual provider version, configuration directory, hook trust and runtime behavior. Minimum versions for automatic restore are listed in [Session state and restore](https://herdr.dev/tui/docs/session-state/#native-agent-session-restore); the tag bundles newer Codex v10 and Claude v11 scripts. Installation status alone does not show that a particular conversation reported successfully.

### Codex: a decisive limitation

The [v0.9.5 hotfix](https://github.com/herdrdev/herdr/releases/tag/v0.9.5) removed Codex turn hooks, returning state detection to the screen. Its [v10 hook](https://github.com/herdrdev/herdr/blob/v0.9.5/src/integration/assets/codex/herdr-agent-state.sh) accepts SessionStart, requires a transcript path and ID, routes by inherited Herdr pane/socket environment, guards against mismatched inherited Codex thread IDs, and sends a best-effort session report. It does not validate the response body and suppresses socket errors. A successfully installed hook can therefore yield no identity.

An OpenAI contributor confirms that in Codex 0.162.1, SessionStart occurs on the first turn rather than at thread creation, and command hooks require individual trust: [upstream issue #54353](https://github.com/openai/codex/issues/54353). The [Codex integration tests](https://github.com/openai/codex/blob/main/codex-rs/core/tests/suite/hooks.rs) also exercise first-turn SessionStart. An interactive TUI resume timing report is tracked in [#51360](https://github.com/openai/codex/issues/51360). Consequently waiting only for a native hook ID before the first prompt may stall indefinitely even with an interactive-ready pane.

Further, Herdr tracks shared Codex app-server misrouting in [#4649](https://github.com/herdrdev/herdr/issues/4649) and [#4814](https://github.com/herdrdev/herdr/issues/4814). Hooks can inherit another pane's routing context, causing absent or incorrect session bindings. The upstream-recorded workaround is to use an embedded/non-daemon Codex launch, where supported; it does not fix previous bad bindings and does not solve first-turn hook timing. These are open upstream reports, not locally reproduced failures.

Finally, `persisted_session_from_launch_args` in [tagged resume source](https://github.com/herdrdev/herdr/blob/v0.9.5/src/agent_resume.rs#L126-L142) constructs a Codex session record directly from a canonical two-argument resume invocation, before independent provider confirmation. [Terminal state](https://github.com/herdrdev/herdr/blob/v0.9.5/src/terminal/state.rs#L1381-L1393) stores that requested value as a managed launch session. Comparing the reported value with the desired ID is therefore insufficient if both come from the launch arguments. An independent provider observation is necessary.

### Claude Code and other lifecycle integrations

The [Claude Code v11 hook](https://github.com/herdrdev/herdr/blob/v0.9.5/src/integration/assets/claude/herdr-agent-state.sh) reads the native session ID on SessionStart, filters subagent events, and optionally includes a transcript path. Like Codex, reporting is best effort over the socket. The v0.9.5 release fixes detection of pending Claude questions in named Herdr sessions; it does not establish a native readiness receipt. Pi, OMP, Kimi, OpenCode, Kilo and MastraCode provide richer lifecycle reporting, but the Adapter still needs to check that the relevant provider session reference was received and matches any requested reference. Do not infer a universal guarantee from those integrations.

## Persistent identity and restore

The installed schema describes `agent_session` as `{source, agent, kind, value}`, where kind is ID or path. This record is distinct from `terminal_id` and `pane_id`. The [tagged normalization code](https://github.com/herdrdev/herdr/blob/v0.9.5/src/agent_resume.rs#L109-L125) uses provider IDs except for Pi and OMP, which prefer an absolute session path. The [same-source replacement guard](https://github.com/herdrdev/herdr/blob/v0.9.5/src/terminal/state.rs#L1287-L1364) accepts replacement only for selected provider events. This helps reject stale and child-session reports but does not prove all reports are correct; for example, Codex's fork source is not on its replacement allowlist.

Restoring a Herdr session has several meanings:

- Detach/reattach preserves the live processes; there is no provider resume call.
- Restart restores layout. If native restore is enabled (default) and an eligible provider reference or reported resume command exists, Herdr launches that provider again with the saved reference.
- Where automatic native restore is unavailable, the restored pane may simply be a shell. Screen history replay is not conversation recovery.
- Live server handoff is best effort and can interrupt in-flight waits and subscriptions.

See [Session state and restore](https://herdr.dev/tui/docs/session-state/). For the closed-pane recovery Runner requires, an Adapter needs to start an Agent in an owned pane with the exact saved provider reference and validate the resulting session. Herdr has no equivalent of T3's provider-independent, queryable native thread catalog and launch receipt in the installed Agent API. The resume planner selects argv, not a verified provider conversation; it also does not preserve every original model, permission, or launch flag. Keep the correct workspace, provider configuration, account and profile as part of the Adapter's recovery context.

## Recommended boundary and fallback

In the proposed design, require the Adapter to provide the following postconditions before Core dispatches a real Assignment:

1. The owned Agent Session is ready for input, with blocked/unknown/exit handled explicitly.
2. The Adapter can establish and return the actual Native Session Reference, not a pane identifier, random Runner ID, latest-session selector or echo of the requested ID.
3. On resume, the verified actual reference equals the saved reference. An absent or mismatched identity is a failure.
4. Close, cancel and recovery act only on the owned target; a state wait is not proof of Assignment success.

For Herdr, use its managed Agent surface when the configured provider supports it. Preserve the generic terminal route for arbitrary commands and unsupported providers; the current opaque command profile cannot safely be treated as canonical Agent argv without a defined mapping.

When a provider supplies a trustworthy reference at readiness, omit the Probe. For Codex's first-turn hook or a missing identity integration, retain an identity-acquisition turn (the existing Probe is one candidate) or use a provider-native identity API. Correlate the acquired reference to the actual conversation and verify persistence/recoverability. A model's claimed ID alone is weaker evidence than a provider query; never fabricate a reference or silently accept the expected ID after resume. Move the readiness/identity acquisition mechanism into the Adapter if Q7 consolidates platform responsibilities, not the workflow's obligation to verify and checkpoint identity. Core should not need separate Herdr-specific polling, hook handling or terminal inference.

This is an architecture recommendation, not evidence that any particular Herdr/provider pair currently meets the stricter contract. Before qualifying one, test fresh launch, first-turn identity, exact resume in a new owned pane after closure, wrong/missing ID, hook trust or delivery failure, concurrent panes, blocked startup, provider or socket exit, and reconnect. For Codex, include shared-daemon routing and explicit resume-argument seeding. For a directly reporting integration, verify the actual reference is unrelated to Herdr's routing handles. Confirm no duplicate or incorrect conversation receives a real Assignment.

## Verification scope

Read-only installed checks: `herdr --version`, top-level and Agent/pane/integration/session help, `agent start/get/wait/prompt --help`, `pane report-agent/report-agent-session --help`, and `herdr api schema --json`. Read local sibling Adapter and Core source. No live provider launch, hook installation, config edits, integration-status inspection, runtime changes or issue mutations. Provider support and error handling must still be exercised in an isolated E2E test before making the guarantee.
