# Terminal plugin contract feasibility: Herdr, tmux, and Zellij

Research date: 2026-10-30, Asia/Shanghai.

Decision input for [Define the public terminal plugin contract and compatibility
boundary][contract-ticket], produced by [Verify terminal contract feasibility
across Herdr, tmux, and Zellij][research-ticket]. This report records evidence and
recommendations; it does not settle the remaining human decisions or implement a
plugin.

## Result

All three backends expose enough primitives to implement a **logical Runner
tab**: a specific interactive terminal created for a Runner stage, independently
addressable for input and closure. A Runner tab need not be a backend-native tab.
Herdr can use a new workspace/project and its root pane; tmux and Zellij can use
panes. Their native representation belongs inside the plugin. See the individual
backend evidence below.

The earlier proposal should be narrowed in two places:

1. Backend routing and terminal identity are feasible, but none of the examined
   basic APIs establishes a universal atomic "operate only if this is still the
   same owned terminal on the same server incarnation" guarantee. Opaque
   plugin-instance handles, explicit routing, native identity checks, and
   invalidation on detected connection/server loss are implementable safeguards.
   They must not be described as proof against every concurrent external
   replacement of a backend or resource.
2. Literal text transport followed by an Enter key is feasible. It does not prove
   that every interactive Agent CLI has accepted a prompt. Newlines, paste mode,
   application input buffering, and platform-specific input handling matter.
   Result/Probe files remain the workflow evidence; a transport success is not a
   successful Issue delivery.

This is positive feasibility evidence for the abstraction, with concrete adapter
obligations. It is not a claim that all three completed plugins exist.

## Evidence baseline

| Backend | Pinned released source | Additional source inspected |
| --- | --- | --- |
| Herdr | [v0.9.5][herdr-release], commit `2ecf19a92fc3a7fff75b6ce3655ef04f4625ec01` | Master `ee5bfb5041bb3e4a49d591c72308aae3c81ecdde`; important behavior checked against the release |
| tmux | [3.8][tmux-release], commit `7f2a35ad3321f9ba57a1062ca73b1f3ff26aca53` | An installed tmux 3.6 was exercised separately |
| Zellij | [v0.45.1][zellij-release], commit `efd8fd5a89a20c07a111d248ad7fce53848d2c18` | Official CLI documentation, checked against the release source |

Released versions above were identified through first-party GitHub release
metadata. Live websites can describe newer development behavior, so pinned
released source governs version-specific claims. Herdr's inspected master and
release agree on the relevant input encoding, terminal ID allocation, direct argv
launch, and workspace/tab creation fields; nearby source differences do not
change these findings.

## Common capability comparison

| Requirement | Herdr | tmux | Zellij |
| --- | --- | --- | --- |
| Select a specific backend namespace | Named session or explicit socket/pipe | Explicit server socket and session | Explicit named session/socket |
| Choose native representation | Workspace plus root pane, or tab/pane | Window or pane | Tab or terminal pane |
| Create with cwd and label | Native workspace/tab parameters | Native cwd; window/pane naming | Native cwd/name; validate cwd before calling |
| Per-process environment overlay | Native launch `env` | Native `-e` | Adapter launch bootstrap required for an existing server |
| Preserve program and argv | Native layout argv launch; shell path also available | Multiple command arguments execute directly | Native command vector; Windows command-line encoding is backend-owned |
| Target input without focus | Explicit pane ID | Explicit `%pane_id` | Explicit typed `terminal_N` pane ID |
| Literal Unicode/multiline paste | `pane.send_input` uses paste mode when enabled | Named buffer plus `paste-buffer -p -r` | Targeted `paste` |
| Separate submission key | `pane.send_keys` or keys in `send_input` | `send-keys ... Enter` | `send-keys --pane-id ... Enter` |
| Close a specific owned terminal | Pane/tab/workspace close | `kill-pane -t` | `close-pane --pane-id` |
| Stable across server restart | Do not assume | Do not assume | Do not assume |
| Native Windows backend | Available, documented platform limits | Not an upstream native Windows target | Available in the examined release |

These cells summarize the cited backend sections, not stronger application-level
delivery guarantees.

## Herdr

### Routing and native representation

The [socket API][herdr-socket-doc] provides named sessions and an explicit socket
override. Selection precedence is explicit CLI `--session`, `HERDR_SOCKET_PATH`,
`HERDR_SESSION`, then the default socket. Unix uses a Unix domain socket; Windows
uses a named pipe. A plugin can resolve its target once and use explicit routing
for every later operation instead of following UI focus.

[Workspace creation][herdr-workspace-schema] accepts cwd, environment, label and
focus, and returns the created workspace, tab and root pane.
[Tab creation][herdr-tab-schema] supports an explicit workspace with the same
launch context. Therefore a new workspace/project with one root terminal is a
valid native implementation of a Runner tab. Core should not call Herdr's
worktree-management operations: existing decisions keep Git Worktree ownership
in Core.

### Starting a command without exposing shell quoting to Core

`pane.send_input` can submit a shell command, but that requires quoting for the
actual configured shell. It is not a raw argv API.

There is a generic alternative: [layout application][herdr-layout-source]
accepts a leaf containing cwd, env and an argv `command`. The implementation
creates a new argv-backed tab before closing the explicitly supplied replacement
tab. [The launcher][herdr-argv-source] passes the first element to
`CommandBuilder::new` and the remaining elements through `arg`, rather than
concatenating a shell command.

An adapter can therefore create its native workspace/context, then implement
logical `startCommand` by replacing its placeholder shell tab with an argv-backed
layout. It updates its private native mapping while Core continues using the same
logical handle. This is an implementation strategy inferred from the public
operation and source, not a live-tested Herdr plugin. A contract that requires the
same underlying PTY to survive `create` and `start` would unnecessarily exclude
this strategy.

### Text, keys and completion evidence

[Pane input handlers][herdr-pane-source] distinguish raw `pane.send_text`,
`pane.send_keys`, and `pane.send_input`. The latter validates the keys before
queueing one encoded input buffer. [Input encoding][herdr-input-source] wraps
text in bracketed-paste delimiters when the target terminal has enabled that mode,
then appends encoded keys. Raw `send_text` alone does not add paste protection.

This supports literal Unicode/multiline transport and submission as separate
logical operations, or one adapter implementation that queues paste plus keys.
A successful response acknowledges queue admission, not Agent execution. The
socket documentation also describes macOS canonical-input-size rejection.

There is an important real application limitation in first-party source:
[Herdr's Agent prompt implementation][herdr-agent-input] includes a Windows
Codex paste-boundary workaround. Its comment explains that buffered paste can turn
a following Enter into a newline, and uses a non-character key to flush that
buffer. The generic pane transport does not establish that all Agent programs
behave identically. Do not silently turn a generic terminal contract into
brand-specific Core completion logic.

### Identity and close

Pane records expose both a public `pane_id` and a distinct `terminal_id`.
[Terminal IDs][herdr-terminal-id] use time plus an atomic counter; public
workspace/pane numbers are allocated through [workspace state][herdr-workspace-id].
Cross-workspace pane moves can change the public pane ID while preserving the
underlying terminal, as documented in the socket API.

The adapter can retain created native references, compare terminal identity when
resolving a target, and either follow supported moves or fail on an invalidated
mapping. It should not reconstruct ownership from a label or current focus.

However, `pane.close` accepts the public pane target, not an expected-terminal-ID
compare-and-close token. A separate `pane.get` check followed by close is not an
atomic guarantee against every external state change. Closing a pane can close
its now-empty tab/workspace; closing a whole workspace can affect additional panes
the operator placed inside it. The plugin must choose the smallest owned native
target matching its representation rather than equating "logical tab" with
"close every object in this project."

### Platforms

[Herdr's Windows documentation][herdr-windows] describes native ConPTY panes and
Windows named-pipe control, along with limitations such as unsupported direct
terminal attach and live server handoff. Those optional capabilities are not
needed by this contract. Windows support is not evidence that POSIX shell strings
are portable; use native argv or adapter-owned platform handling.

## tmux

### Routing, creation and launch

The [3.8 manual][tmux-manual] documents `-L` server socket names and `-S` explicit
socket paths. Session, window and pane IDs are server-local immutable IDs, with
pane IDs prefixed `%`; names and layout indexes are not substitutes for these IDs.

`new-window`, `split-window` and `respawn-pane` provide cwd and environment
options. Creation can print the created pane ID using `-P -F '#{pane_id}'`.
Multiple command arguments execute directly without a shell; a single
shell-command string has different semantics. This supports a plugin-owned pane,
direct argv launch, and a separate later prompt submission.

If the logical API separates create from start, a plugin can retain a placeholder
pane and use `respawn-pane` for its owned target, or defer physical process
creation until start. The public contract should specify observable logical
behavior rather than an immutable underlying PTY allocation sequence.

### Literal paste and keys

Use a unique buffer populated through `load-buffer ... -` from stdin, then target
the pane with `paste-buffer -p -r`. `-p` uses bracketed paste when the target
application enabled it; `-r` preserves LF instead of the default LF-to-CR
translation. A separate `send-keys -t %id Enter` sends the submission key.

The 3.8 manual also documents control-character sanitization and `-S` for
disabling it. Ordinary Unicode text with LF is different from arbitrary terminal
control bytes. A future contract should define its accepted text domain instead
of accidentally promising to inject every possible escape/control sequence.
The installed 3.6 test below predates that 3.8 sanitization behavior.

### Close and identity limitations

`kill-pane -t %id` targets one pane without relying on focus. The
[ID allocator][tmux-pane-id] increments `next_window_pane_id` in one server
process. Restarting a server resets its namespace; the same `%0` can denote a
different terminal. This was observed directly in the smoke test.

A long-lived control-mode connection can bind operations to one server lifetime;
a newly spawned CLI command reconnects through a socket name/path. Checking a PID
and then issuing another CLI command is not an atomic guarantee against server
replacement between those steps. Persistent transport and/or private
adapter-owned namespaces can strengthen the implementation; they remain adapter
choices. Persisted bare pane IDs must not be treated as restart-safe handles.

### Platforms

The [upstream supported platform list][tmux-platforms] names OpenBSD, FreeBSD,
NetBSD, Linux, macOS and Solaris. Native Windows is not an upstream target.
Windows users can choose a Linux/WSL environment for a tmux adapter, but paths and
processes then belong to that environment. A portable Core contract does not
require every backend to run natively on every Core-supported OS.

## Zellij

### Routing, creation and launch

The examined stable release provides
`zellij attach --create-background NAME`, and
`zellij --session NAME action ...` selects a named session.
The [CLI source][zellij-cli] defines `new-pane` with a command vector, cwd, name,
no-focus and tab targeting. The [official action documentation][zellij-actions]
describes returning the new pane ID. Use typed `terminal_N` IDs to distinguish
terminal panes from plugin panes.

The [Unix launcher][zellij-unix] passes command arguments through a native
argument vector. Unlike Herdr and tmux, stable `new-pane` has no general
per-pane environment overlay field. Setting environment variables on a short-lived
`zellij action` client does not establish that the already-running server will
apply them to the new process. An adapter can launch an explicit bootstrap,
such as `env KEY=value program args` on Unix, or a platform-specific helper that
applies the environment and execs the requested program. That is plugin work,
not a reason to remove environment semantics from Core's contract.

Also, the Unix launcher logs an invalid cwd and can fall back to an inherited
directory instead of rejecting creation. An adapter must validate the requested
directory and avoid claiming success with the wrong working context. As with
other filesystem validation, a precheck alone does not eliminate every external
filesystem race.

### Text, keys and close

The release CLI has targeted `write`, `write-chars`, `paste`, `send-keys` and
`close-pane` actions with `--pane-id`. This enables direct addressing rather than
focus-switching automation, including bracketed paste followed by a submission
key. Distinguish `paste` from writing newline-containing bytes as ordinary keys.

There is a significant acknowledgement limitation in
[server screen dispatch][zellij-screen]: targeted write/paste/key handling searches
for the target pane and can fall through when it is missing; some input errors
are treated as non-fatal. A successful CLI exit cannot by itself prove that the
pane still exists, much less that an Agent accepted the prompt. The live negative
test below confirmed exit 0 when pasting to an already-closed pane.

The adapter can track the IDs it created and preflight authoritative pane
enumeration to reject known stale targets. That does not create an atomic
compare-and-write primitive. Required contract outcomes should reflect the
evidence the adapter can establish.

### Identity and platforms

[Unix][zellij-unix] and [Windows][zellij-windows] terminal-ID counters increase
within a backend process and reset with a new backend. They are finite integer
counters, not globally unique durable identifiers. Session socket routing
[uses the session name][zellij-session-source], not a server-incarnation token.
Scope handles to a live plugin/backend lifetime and invalidate on known loss;
do not reuse saved `terminal_N` as a recovery adoption target.

The examined v0.45.1 release includes native Windows MSI/ZIP assets and
[ConPTY/CreateProcess source][zellij-windows]. Older claims that Zellij necessarily
requires WSL on Windows do not apply to this release. Native Windows argv quoting
is performed inside the backend; exact edge-case round trips still require
Windows testing.

## Runtime checks actually performed

### tmux 3.6 in Ubuntu on WSL2

The parent session ran an isolated Python assert-based smoke test using
`tmux -L <unique-name> -f /dev/null`; no existing user session was targeted.
Environment: tmux 3.6, Python 3.14.4, Linux 6.18.33.2 under WSL2.

The checks passed:

- Create a dedicated server and an original pane, then an owned pane while the
  original remains available.
- Launch a raw receiver using a cwd containing spaces, an explicit environment
  value, and argv containing spaces, both quote styles, semicolons, `$HOME` and
  `$(...)`; observe the exact cwd/env/argv without shell expansion.
- Focus the original pane, then send a Unicode/multiline payload to the owned pane
  through a named stdin-loaded buffer and `paste-buffer -p -r -d`.
- Observe exact UTF-8 payload bytes and preserved LF inside bracketed-paste
  delimiters, followed by CR from a separate Enter.
- Close the owned pane and verify that only the original pane remains.
- Restart the isolated server and observe `%0` being reused while its server PID
  changes, demonstrating why a pane ID alone is not a durable identity.

The initial variant using `paste-buffer -p` without `-r` failed the exact-byte
assertion because LF became CR. Adding the documented `-r` corrected the test.
Test-created servers, processes and scratch data were cleaned in `finally`.

The raw receiver deliberately enabled bracketed paste and raw terminal mode.
These checks verify terminal transport, not any authenticated Agent CLI's prompt
acceptance or the whole workflow.

### Zellij 0.45.1 in Ubuntu on WSL2

The parent session downloaded the official no-web Linux musl release artifact
into temporary storage, checked its archive digest against GitHub release
metadata, and checked the extracted binary against the published checksum. This
was a temporary test binary, not a persistent installation.

An isolated Python assert-based smoke test used a unique session, short private
XDG/socket directories and `session_serialization false`. The checks passed:

- Create the detached session with an original terminal pane.
- Create `terminal_1` through `new-pane --cwd <path-with-spaces> --name <label>
  --no-focus -- /usr/bin/env IR_CONTRACT_TEST=<value> python3 <receiver> <argument>`.
- Observe exact cwd, environment value and argv, including shell metacharacters;
  pane enumeration showed the new target was not focused.
- Send targeted Unicode/multiline `paste`, then `send-keys ... Enter` and a
  receiver-only end marker; observe exact bracketed-paste delimiters, UTF-8
  payload, preserved LF and the final CR.
- Close the owned terminal and verify the original terminal was the only
  remaining terminal.
- Paste to the already-closed `terminal_1`: the CLI returned exit 0 with no output.
  This is a confirmed transport-acknowledgement limitation, not success evidence.

Initial diagnostics found a 139-byte Unix socket path exceeded the 107-byte
limit; shorter private paths corrected that setup. Sending paste immediately
after the receiver emitted the paste-mode escape sequence could race the
terminal parser; a 0.2-second diagnostic wait after receiver readiness produced
the expected wrappers. This is a controlled-test timing condition, not proof
that arbitrary Agent programs are ready after that delay.

Only the test session and scratch data were closed/removed. No user session was
targeted.

### Reproduction shape and remaining test limits

Both smoke tests used a small receiver that calls `tty.setraw(0)`, enables
bracketed paste by writing `ESC[?2004h`, reports cwd/env/argv to a scratch JSON
file, and records input bytes until a test-only Ctrl-D marker. Expected bytes
were `ESC[200~` + the unchanged UTF-8 text containing LF + `ESC[201~` + CR.
The payload included Chinese characters, both quote forms, `$HOME`, `$(...)` and
semicolons to expose shell interpretation or text rewriting.

The essential adapter operations exercised were:

```text
tmux -L UNIQUE -f /dev/null split-window -d -P -F '#{pane_id}'
  -t ORIGINAL -c CWD -e KEY=VALUE python3 RECEIVER ARG
tmux -L UNIQUE -f /dev/null load-buffer -b UNIQUE_BUFFER -
tmux -L UNIQUE -f /dev/null paste-buffer -p -r -d -b UNIQUE_BUFFER -t OWNED
tmux -L UNIQUE -f /dev/null send-keys -t OWNED Enter
tmux -L UNIQUE -f /dev/null kill-pane -t OWNED

zellij attach --create-background UNIQUE_SESSION
zellij --session UNIQUE_SESSION action new-pane --cwd CWD --name LABEL
  --no-focus -- /usr/bin/env KEY=VALUE python3 RECEIVER ARG
zellij --session UNIQUE_SESSION action paste --pane-id terminal_N TEXT
zellij --session UNIQUE_SESSION action send-keys --pane-id terminal_N Enter
zellij --session UNIQUE_SESSION action close-pane --pane-id terminal_N
```

These are command shapes: execute each wrapped command as one argv vector, use
unique test-only names/paths, establish the initial session, wait for receiver
readiness, and clean only those test resources in `finally`.

Herdr was investigated through its released source and documentation; no live
Herdr/Agent session was exercised by this research agent.
Neither native Windows nor macOS runtime behavior, real Agent prompt acceptance,
an atomic ownership protocol, nor a packaged plugin implementation was tested.

## Contract implications for the human decision

These are recommendations, not decisions made on the human's behalf:

1. Define Runner tab by its observable lifecycle, not by backend-native UI
   structure. Allow the adapter to allocate/replace native objects while retaining
   its logical handle.
2. Let initialization resolve an explicit environment target from plugin
   configuration or unambiguous inherited context. Do not require a Herdr-shaped
   "window ID" field in the public Core interface.
3. Return a plugin-instance-scoped opaque handle, use explicit native addressing,
   retain created-resource ownership, and reject known invalidation. Do not expose
   mutable labels or selected focus as identity.
4. Invalidate old handles after detected backend restart or loss. The settled
   recovery path creates a new terminal and resumes a saved Agent conversation;
   it does not need old live-tab adoption.
5. Promise supported text/key transport semantics and meaningful transport
   errors, not app-level receipt or task completion. Specify Unicode/newline
   handling, submit-key behavior, permitted controls and cancellation separately.
6. Keep cwd/env/program/argv as Core inputs, but let adapters choose native launch,
   respawn/replacement, quoting or a bootstrap to implement them. Test the
   packaged contract using a controlled receiver, plus separate real Agent E2E.
7. Do not require an unconditional cross-backend atomic ownership assertion that
   these primitives do not supply. If that stronger guarantee is desired, it
   needs a separate threat model and implementation decision.

There is no evidence-based need to discard the logical tab abstraction or make
Core understand native Herdr workspaces, tmux panes or Zellij pane layouts.
Full implementation acceptance still needs a fake-plugin contract seam and real
Herdr/Agent testing; backend operation availability alone is insufficient.

## Sources

[contract-ticket]: https://github.com/BuddyLabsCo/issue-runner-core/issues/8
[research-ticket]: https://github.com/BuddyLabsCo/issue-runner-core/issues/13
[herdr-release]: https://github.com/herdrdev/herdr/releases/tag/v0.9.5
[herdr-socket-doc]: https://herdr.dev/docs/socket-api/
[herdr-workspace-schema]: https://github.com/herdrdev/herdr/blob/2ecf19a92fc3a7fff75b6ce3655ef04f4625ec01/src/api/schema/workspaces.rs
[herdr-tab-schema]: https://github.com/herdrdev/herdr/blob/2ecf19a92fc3a7fff75b6ce3655ef04f4625ec01/src/api/schema/tabs.rs
[herdr-layout-source]: https://github.com/herdrdev/herdr/blob/2ecf19a92fc3a7fff75b6ce3655ef04f4625ec01/src/app/api/layouts.rs#L34
[herdr-argv-source]: https://github.com/herdrdev/herdr/blob/2ecf19a92fc3a7fff75b6ce3655ef04f4625ec01/src/pane.rs#L2456
[herdr-pane-source]: https://github.com/herdrdev/herdr/blob/2ecf19a92fc3a7fff75b6ce3655ef04f4625ec01/src/app/api/panes.rs#L1912
[herdr-input-source]: https://github.com/herdrdev/herdr/blob/2ecf19a92fc3a7fff75b6ce3655ef04f4625ec01/src/app/api_helpers.rs#L25
[herdr-agent-input]: https://github.com/herdrdev/herdr/blob/2ecf19a92fc3a7fff75b6ce3655ef04f4625ec01/src/app/api/agents.rs#L13
[herdr-terminal-id]: https://github.com/herdrdev/herdr/blob/2ecf19a92fc3a7fff75b6ce3655ef04f4625ec01/src/terminal/id.rs
[herdr-workspace-id]: https://github.com/herdrdev/herdr/blob/2ecf19a92fc3a7fff75b6ce3655ef04f4625ec01/src/workspace.rs#L104
[herdr-windows]: https://github.com/herdrdev/herdr/blob/2ecf19a92fc3a7fff75b6ce3655ef04f4625ec01/docs/next/website/src/content/docs/windows-beta.mdx
[tmux-release]: https://github.com/tmux/tmux/releases/tag/3.8
[tmux-manual]: https://github.com/tmux/tmux/blob/7f2a35ad3321f9ba57a1062ca73b1f3ff26aca53/tmux.1
[tmux-pane-id]: https://github.com/tmux/tmux/blob/7f2a35ad3321f9ba57a1062ca73b1f3ff26aca53/window.c#L61
[tmux-platforms]: https://github.com/tmux/tmux/blob/7f2a35ad3321f9ba57a1062ca73b1f3ff26aca53/README#L1
[zellij-release]: https://github.com/zellij-org/zellij/releases/tag/v0.45.1
[zellij-actions]: https://zellij.dev/documentation/cli-actions.html
[zellij-cli]: https://github.com/zellij-org/zellij/blob/efd8fd5a89a20c07a111d248ad7fce53848d2c18/zellij-utils/src/cli.rs
[zellij-unix]: https://github.com/zellij-org/zellij/blob/efd8fd5a89a20c07a111d248ad7fce53848d2c18/zellij-server/src/os_input_output_unix.rs
[zellij-windows]: https://github.com/zellij-org/zellij/blob/efd8fd5a89a20c07a111d248ad7fce53848d2c18/zellij-server/src/os_input_output_windows.rs
[zellij-screen]: https://github.com/zellij-org/zellij/blob/efd8fd5a89a20c07a111d248ad7fce53848d2c18/zellij-server/src/screen.rs#L11652
[zellij-session-source]: https://github.com/zellij-org/zellij/blob/efd8fd5a89a20c07a111d248ad7fce53848d2c18/zellij-client/src/cli_client.rs#L19
