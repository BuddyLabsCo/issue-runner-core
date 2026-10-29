# Herdr input with real Codex and CodeBuddy CLIs

Research date: 2026-10-30, Asia/Shanghai.

Evidence for [Validate Herdr paste and submission with real Codex and CodeBuddy
CLIs][research-ticket], informing [Define the public terminal plugin contract and
compatibility boundary][contract-ticket]. This is an experiment report, not a
public-contract decision or a runtime plugin implementation.

## Result

Real native-Windows Agent tests found two concrete problems that a raw
"text followed immediately by Enter" contract would hide:

1. Immediate generic text plus Enter submitted in CodeBuddy, but left Codex's
   single-line prompt pending for 84.4 seconds until a non-character boundary and
   Enter were sent.
2. Raw CRLF text was changed by both input paths. CodeBuddy converted each CRLF
   to one LF; Codex converted each CRLF to two LF, adding blank lines.

For these installed versions, canonical LF text followed by generic Right and
Enter in one `pane.send_input` call preserved multiline/CJK prompts and submitted
successfully in both CLIs, without branching on Agent brand. Explicitly
normalizing CRLF source text to LF before that call also passed in both. Native
user-message equality and exact assistant markers establish these results, not
Herdr's success response alone.

These are bounded positive results, not a universal input recipe. They support a
semantic "submit text" operation whose implementation owns text encoding and the
submission boundary. Choosing that public contract remains the human's Q4
decision.

## Scope and isolation

The human explicitly authorized installing Herdr and testing the locally
installed interactive Codex CLI and CodeBuddy CLI. The parent research session
owns the installation and runtime experiments. This report is written separately
from the dirty Core working tree.

The experiment uses a dedicated named Herdr session, native Windows ConPTY
terminals, and synthetic prompts in a test Git directory. Existing Agent login
and provider configuration are reused without publishing them. Codex folder
trust was accepted only for that scratch directory; its review of changed hooks
used "Continue without trusting." This is not a claim that no persistent setting
changed: the scratch-folder trust choice was saved. No provider or authentication
setting was modified.

Generic pane operations are the transport under test; an Agent-specific Herdr
prompt API is not a substitute for that test.

## Version and installation baseline

| Component | Observed baseline |
| --- | --- |
| Herdr | Official Windows x86-64 v0.9.5, API protocol 22 |
| Herdr source | Release commit `2ecf19a92fc3a7fff75b6ce3655ef04f4625ec01` |
| Herdr archive SHA-256 | `d2c6c9c971c43a0bfdde8c692a9a1a7a45c3e4807cd01ae45662b4734fac1cbf` |
| Codex CLI | `codex-cli 0.165.0` from the local installed executable |
| CodeBuddy CLI | `2.178.0` from the local installed CLI |

Herdr was extracted from its [official release artifact][herdr-release] into a
separate user-local installation directory, including the bundled ConPTY
runtime. It was not built from modified source. [Windows documentation][windows]
describes native ConPTY support and Windows-specific input limitations.

Use the launched CLI's actual version output when reproducing: the installed
CodeBuddy npm package manifest and its launched version can differ.

## Transport under investigation

Herdr's bundled schema defines generic pane input as:

```json
{
  "id": "synthetic-test-id",
  "method": "pane.send_input",
  "params": {
    "pane_id": "the-created-pane",
    "text": "first line\nsecond line",
    "keys": ["enter"]
  }
}
```

Only `pane_id` is required; absent text/keys do not require placeholder nulls.
The actual test clients must encode the entire request as UTF-8 JSON followed by
LF, and read a JSON response line. This framing is established by the
[released API client][api-client]. Windows maps the logical socket path through
`GenericNamespaced` to a named pipe; [Herdr's IPC source][ipc] and the exact
[interprocess dependency documentation][interprocess] establish that mapping.

The [generic input encoder][input-encoder] wraps text in bracketed-paste
delimiters only when the target runtime reports that mode enabled. It then
appends encoded key bytes. `pane.send_text` is a different raw text path; treating
it as equivalent to paste would change the tested operation.

For direct argv launch, [layout application][layout] supports a pane leaf with
`command`, `cwd` and `env`. That is a source-established alternative, not the
startup route exercised here. Actual startup used generic `pane.run` command
submission into known PowerShell shells. Synthetic task prompts were submitted
later through the terminal input path. This experiment does not validate native
argv startup or decide whether public creation and startup should be merged.

## Source-based hypotheses to test

The [released Agent prompt implementation][agent-input] contains a specific
Windows Codex workaround. Its comment explains that Codex can buffer a
character-input burst and reinterpret a following Enter as a newline while the
burst remains buffered. A non-character Right key forces the buffered burst to
flush. The Agent-specific API appends that key for detected Codex and separately
queues submission with a 300 ms delay.

These source facts motivate comparing ordinary generic text-plus-Enter with a
generic non-character boundary and with separately sent text/keys. They are not
evidence that any tested sequence worked in the installed real CLIs.

## Observed experiments

### Real interactive processes

Codex was started as the installed interactive CLI with `--no-daemon`,
`--no-alt-screen`, `--ask-for-approval never`, `--sandbox read-only`, and the
scratch directory supplied with `-C`. CodeBuddy ran as the installed Node CLI
with its tool set disabled for this invocation and an empty strict MCP
configuration. Neither test used `codex exec`, CodeBuddy `--print`, an API-only
replacement, or Herdr's Agent-specific `agent.prompt`.

Both used the existing authenticated account and default model configuration.
CodeBuddy inherited the existing permission default, while its tools were
disabled for this invocation. Codex displayed changed-hook/plugin warnings after
the hooks were not trusted; those warnings did not prevent the model responses
reported below.

### Acceptance evidence

Herdr API responses were checked for matching request IDs and reported errors.
Actual submission was checked separately against the native Agent histories:

- Exactly one accepted user message for the synthetic case.
- Exact text equality with the original prompt, including LF and literal data.
- Exactly one assistant response matching that case's requested marker.

Only these sanitized checks and the synthetic input are relevant evidence. Full
native histories, credentials and private provider configuration are not
published. The native histories remain under each Agent's own storage policy.

### Immediate text plus Enter

Each process received one generic `pane.send_input` request with a short
single-line synthetic prompt and `keys: ["enter"]`.

| CLI | Initial outcome |
| --- | --- |
| CodeBuddy | One exact user message accepted and the requested marker returned |
| Codex | Prompt remained in the composer for more than 60 seconds, with no accepted user message |

The Codex request was sent at `2026-10-29T18:23:44.5645314Z`. At
`2026-10-29T18:25:08.9561315Z`, after the pending draft was confirmed, the parent
sent only `pane.send_keys` with `["right", "enter"]`. It did not resend the text.
The pending prompt was then accepted exactly once, matched the original text,
and produced its requested marker. The interval between those timestamps is
84.4 seconds. They are raw UTC timestamps; the local research date is October 30
in Asia/Shanghai.

This is a failed immediate-submission strategy followed by a successful
correction, not an initial Codex pass. It reproduces the meaningful distinction
between input queue acceptance and a real Agent accepting a user message.

### Paste, wait, then Enter

The next prompts contained actual CJK characters, LF, a blank line, indentation,
both quote styles, and literal `$HOME`, `$(1+2)`, `A&B`, and `C:\temp\a b`.
They instructed the model not to use tools and to return a unique marker.

The parent sent `pane.send_input` with text and no submission keys, waited at
least one second and inspected the composer, then called `pane.send_keys` with
`["enter"]`. Both CLIs accepted exactly one user message equal to the full
original LF string and returned the corresponding marker once.

This proves that the installed real input composers can preserve these
multiline/literal prompts. The finite wait is an observed successful test
condition, not a universal readiness or paste-flush guarantee.

### Text, Right, Enter without a deliberate gap

The parent next submitted a new multiline/CJK prompt to each process using one
generic `pane.send_input` request with `keys: ["right", "enter"]`, without a
deliberate inter-part delay. Both accepted exactly one user message equal to the
complete original LF string and returned their exact requested marker once.

This was a fresh follow-up in the same original conversation for each CLI. It
did not depend on resending a pending prompt or selecting a brand-specific
Herdr input API.

### Raw Windows CRLF

The next synthetic prompts used Windows CRLF line endings throughout, with
eight CRLF pairs including an intentionally blank line. They were sent directly
using the same generic text, Right, Enter sequence.

Both CLIs accepted one user message and returned the correct marker. Neither
accepted string was exactly equal to the source:

| CLI | Observed exact transformation |
| --- | --- |
| CodeBuddy | Each CRLF became one LF: eight CRLF pairs became eight LF |
| Codex | Each CRLF became two LF: eight CRLF pairs became sixteen LF |

Independent comparison of the sanitized expected and actual messages confirmed
that replacing CRLF with the respective sequence accounts for the entire
difference; the remaining literal data was unchanged. In Codex, a Windows line
break thus added an unwanted blank line, and an intended blank line expanded
further. A correct response marker alone would have missed this corruption.

For illustration, an input segment `a\r\nb` corresponds to observed `a\nb` in
CodeBuddy and `a\n\nb` in Codex. These escaped strings describe actual line-ending
characters, not backslash letters pasted to the CLIs.

### Normalize Windows source to LF before submission

The final fresh follow-up used the same style of Windows CRLF source prompt.
The test caller normalized it before calling Herdr:

```javascript
const text = sourceText.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
```

The caller then sent one generic `pane.send_input` request with that normalized
text and `keys: ["right", "enter"]`. Both native histories contained exactly one
user message equal to the complete normalized LF string, with one exact marker
response. The source prompt and normalized payload were recorded separately.

The source in this case contained CRLF, not isolated CR. The normalizer handles
isolated CR syntactically, but this experiment did not independently test a
standalone-CR input case.

### Compact result matrix

| Synthetic case | Codex 0.165.0 | CodeBuddy 2.178.0 |
| --- | --- | --- |
| Single line, immediate text + Enter | Initial failure; pending 84.4 s, then Right + Enter corrected without resending | Exact text and response |
| LF multiline, text then wait and Enter | Exact text and response | Exact text and response |
| LF multiline, immediate text + Right + Enter | Exact text and response | Exact text and response |
| Raw CRLF, immediate text + Right + Enter | Submitted, but CRLF became double LF | Submitted, but CRLF became LF |
| CRLF source normalized to LF, then immediate text + Right + Enter | Exact normalized text and response | Exact normalized text and response |

After the explicit correction of the first Codex draft, the final native
histories held ten accepted synthetic case messages and ten exact marker
responses: five of each per CLI. Eight accepted messages matched their assigned
payload exactly. The two raw-CRLF cases did not, and remain findings rather than
being reported as passes.

## Reproduction shape

Start each interactive CLI in its own synthetic test Git directory through a
known shell. Accept any scratch-folder trust prompt separately from the test
input, preserve existing authentication, and establish that the composer is
ready. Do not paste task text into the startup command.

Use only the created pane ID for these generic requests:

```text
A: pane.send_input {pane_id, text: singleLine, keys: ["enter"]}
B: pane.send_input {pane_id, text: multilineLF}
   wait at least the recorded test interval, inspect composer
   pane.send_keys {pane_id, keys: ["enter"]}
C: pane.send_input {pane_id, text: multilineLF, keys: ["right", "enter"]}
D: pane.send_input {pane_id, text: multilineCRLF, keys: ["right", "enter"]}
E: normalize CRLF source to LF
   pane.send_input {pane_id, text: normalizedLF, keys: ["right", "enter"]}
```

Each prompt must have its own marker, contain instructions not to use tools, and
request one exact marker response. For exactness checks, compare the native
accepted user-message string with the assigned payload; checking only rendered
screen text or the returned marker is insufficient. The delayed case and the
failed Codex draft also need observations before their submission key or
correction, so that a later response is not mistaken for an initial success.

The parent kept its small Node named-pipe client, synthetic case files and
sanitized receipt checks in the local experiment directory. Full native Agent
histories were inspected only for the synthetic messages and were not copied
into this research branch.

## Implications and limits

For the human contract discussion:

- A semantic submission operation is useful even if its backend eventually
  writes bytes and keys. The exact LF content and final submission boundary are
  meaningful observable behavior.
- Canonical LF at the Core/plugin boundary avoids the observed Windows
  line-ending ambiguity. Where normalization belongs remains a public-contract
  decision; the experiment performed it in the caller.
- Generic Right followed by Enter is a working candidate for the examined
  Windows combinations. It did not require Core to enumerate Agent brands, but
  it must not be generalized beyond this evidence.
- A fixed wait also worked in the recorded delayed cases. Neither that result
  nor the fixed startup delay proves all future pastes will flush in time.
- Existing Probe/result-file validation remains necessary. No transport return
  alone establishes Agent receipt or successful Issue delivery.

The experiment does not verify arbitrary Agent brands, larger pastes, every
control character, native argv startup, exact conversation resume, Agent crash
recovery, macOS/Linux, or the full Runner workflow. These short prompts used real
authenticated model responses, not a fake receiver, but they did not exercise
tool execution or change repository files.

The parent verified both synthetic Git directories remained clean, with no model
file mutations. It stopped only the named research Herdr session, checked that
its status was no longer running, and confirmed the known research server PID was
absent. The default session was not targeted.

The user-local Herdr installation, stopped named-session state, scratch
diagnostics and native Agent histories were retained as evidence. No persistent
PATH update was made. Retaining that evidence does not change the Runner's
previously settled cleanup or native-history ownership policies.

## Sources

[research-ticket]: https://github.com/BuddyLabsCo/issue-runner-core/issues/14
[contract-ticket]: https://github.com/BuddyLabsCo/issue-runner-core/issues/8
[herdr-release]: https://github.com/herdrdev/herdr/releases/tag/v0.9.5
[windows]: https://herdr.dev/docs/windows-beta/
[api-client]: https://github.com/herdrdev/herdr/blob/2ecf19a92fc3a7fff75b6ce3655ef04f4625ec01/src/api/client.rs#L185
[ipc]: https://github.com/herdrdev/herdr/blob/2ecf19a92fc3a7fff75b6ce3655ef04f4625ec01/src/ipc.rs#L35
[interprocess]: https://docs.rs/interprocess/2.4.4/interprocess/local_socket/enum.GenericNamespaced.html
[input-encoder]: https://github.com/herdrdev/herdr/blob/2ecf19a92fc3a7fff75b6ce3655ef04f4625ec01/src/app/api_helpers.rs#L25
[layout]: https://github.com/herdrdev/herdr/blob/2ecf19a92fc3a7fff75b6ce3655ef04f4625ec01/src/app/api/layouts.rs#L34
[agent-input]: https://github.com/herdrdev/herdr/blob/2ecf19a92fc3a7fff75b6ce3655ef04f4625ec01/src/app/api/agents.rs#L13
