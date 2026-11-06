# Issue Runner Core

Issue Runner coordinates AI work on GitHub Issues: it selects eligible work, creates isolated Worktrees, verifies commits, publishes pull requests, waits for checks, and coordinates integration and Issue closure. AI focus on implementation, Review, and repairs; Runner handles the workflow.

Core is a library only. You need to install terminal multiplexer plugin to start Issue Runner, e.g. [issue-runner-herdr](https://github.com/BuddyLabsCo/issue-runner-herdr)  
You can use issue runner with any AI agent cli supporting interactive session, e.g. claude, pi, codex, codebuddy, etc...

## What it can do?
Automatically resolve your issue list via interactive AI session.
![Issue Runner demo](docs/assets/demo.gif)

## Workflow overview

<details>
<summary>Expand the Parent Run workflow</summary>

This example delivers three eligible children with two Issues per Batch and automatic documentation triggered by #44. `AI:` marks Agent work.

```mermaid
flowchart TD
    P["Parent #42: children #43, #44, #45"] --> A43 & A44
    subgraph B1["Batch 1: two Issues in parallel"]
        A43["Issue #43"] --> I43["AI: implement"] --> R43["AI: Review"]
        R43 -- "Findings: fix in original conversation" --> I43
        R43 -- Passed --> PR43["Publish PR"] --> C43["Wait for checks"]
        C43 -- Failed --> CI43["AI: repair CI"] --> C43
        A44["Issue #44: documentation trigger label"] --> I44["AI: implement"]
        I44 --> R44["AI: Review"]
        R44 -- "Findings: fix in original conversation" --> I44
        R44 -- Passed --> PR44["Publish PR"] --> C44["Wait for checks"]
        C44 -- Failed --> CI44["AI: repair CI"] --> C44
    end
    C43 & C44 -- Ready --> G["Wait until every Batch PR is ready"]
    G --> M["Integrate PRs serially"]
    M -- Conflict --> MC["AI: repair conflict"] --> M
    M -- Merged --> T["Confirm Issue closure; clean successful resources"]
    T --> D["Create Maintenance Ticket triggered by #44"]
    D --> U["AI: update documentation"] --> Q{"Documentation changed?"}
    Q -- Yes --> DP["Publish documentation PR"] --> DC["Wait for checks"]
    DC -- Failed --> DCI["AI: repair CI"] --> DC
    DC -- Ready --> DM["Integrate documentation PR"]
    DM -- Conflict --> DMC["AI: repair conflict"] --> DM
    DM --> DF["Close Maintenance Ticket"]
    Q -- No --> DF
    DF --> DW["Clean successful resources"] --> A45
    subgraph B2["Batch 2: remaining Issue"]
        A45["Issue #45"] --> I45["AI: implement"] --> R45["AI: Review"]
        R45 -- Findings --> I45
        R45 -- Passed --> PR45["Publish PR"] --> C45["Wait for checks"]
        C45 -- Failed --> CI45["AI: repair CI"] --> C45
        C45 -- Ready --> M45["Integrate PR"]
        M45 -- Conflict --> MC45["AI: repair conflict"] --> M45
        M45 --> T45["Confirm #45 closed; clean successful resources"]
    end
    T45 --> F["Rescan children; close Parent #42"]
```

Review can be disabled. An ordinary Issue with no changes receives no delivery credit; verified documentation with no changes closes its Maintenance Ticket without a PR. Unfinished work retains its resources.

</details>

## Prerequisites

Prepare these on the machine and in the shell that runs the terminal command:

- Node.js 22.18.0 or later and npm 11 or later, including subsequent major versions
- Git with Worktree support, configured author identity, and access to push to the repository
- GitHub CLI (`gh`) on `PATH`, with credentials that can read/write Issues, pull requests, and repository contents and observe required checks
- An absolute-path repository checkout with working Git/GitHub credentials
- An installed, authenticated Agent CLI for every configured role, with its own skills, native permissions, and required tools
- A supported terminal multiplexer plugin, e.g. [issue-runner-herdr](https://github.com/BuddyLabsCo/issue-runner-herdr) which use herdr as issue-runner-core environment

### macOS and Linux

Install those tools, then verify them in the shell inside your selected terminal:

```sh
node --version          # At least 22.18.0
npm --version           # At least 11
git --version
gh --version
codex --version         # AI agent cli tool you will use
export GH_TOKEN='your_github_token' # github token
npm install --global issue-runner-herdr # Installs Core transitively
```

### Windows

Install the same tools natively and reopen PowerShell so `PATH` changes take effect. Use shell syntax your terminal and Agent commands support:

```powershell
node --version          # At least 22.18.0
npm --version           # At least 11
git --version
gh --version
codex --version         # Repeat for each Agent CLI you configure
$env:GH_TOKEN = 'your_github_token' # github token
npm install --global issue-runner-herdr # Installs Core transitively
```

### Install the handoff skill

Install the bundled [issue-runner-handoff](skills/issue-runner-handoff/SKILL.md) skill.  

Runner workflow context handover is based on this skill, make sure it's accessible in your ai agent.

### Optional Agent enhancements

Base startup works without an enhancement.  
You can install [issue-runner-agent-codex](https://github.com/BuddyLabsCo/issue-runner-agent-codex) for extra codex auto-recover ability

```sh
npm install --global issue-runner-agent-codex
```

## Getting started

Use the runner in a clean folder.

```sh
issue-runner-herdr --help          # Command overview; -h also works
issue-runner-herdr --version       # Terminal command and loaded Core versions
issue-runner-herdr run --help      # Run selectors and options
issue-runner-herdr init --project my-project # Creates config and three prompts template
```

Edit `my-project/config.yaml` using its comments, replace its placeholders, and adapt the Agent commands to your shell. The [shipped configuration template](templates/config.yaml) contains all field guidance. Edit the three Project prompts under `my-project/prompts/` for implementation, Review, and documentation instructions. Run from the same Launch Directory; Runner looks only in its selected Project child directory.

Make sure your AI agent cli can start from the configured checkout folder without interactive popup e.g. Trust folder, Trust hooks. 

```sh
issue-runner-herdr run --project my-project --parent 42 # Deliver eligible children
issue-runner-herdr run --project my-project --issue 43  # Deliver one Issue
issue-runner-herdr run --project my-project --issue     # Use configured Issue List
issue-runner-herdr run --project my-project --issue 43 --no-auto-merge # Retain PR/work
issue-runner-herdr run --project my-project --document  # Create Maintenance Ticket
issue-runner-herdr run --project my-project --document --no-auto-merge # Retain doc PR
```

Auto-merge defaults on. `--no-auto-merge` applies to numbered Issues and standalone documentation; retained, unmerged work reports `incomplete`. Runner owns push, PR, integration, and tracker operations. Agents report local work through handoffs; a handoff alone does not establish delivery.

## Known issues

### CodeBuddy requires `--port 0`

CodeBuddy can select the same cached HTTP port in concurrently starting processes. One process then fails with `EADDRINUSE` before its interactive interface is ready, leaving the Session Probe echoed in the terminal.  

`--port 0` lets the operating system allocate an available port when the server binds. The Web UI address can change between launches, so external clients must not assume a fixed port.

### Disable Codex startup update checks

Codex can show an interactive update prompt at startup, interrupting Runner's automated input. Add `-c check_for_update_on_startup=false` to both Codex `start` and `resume` commands to disable this check. The [configuration template](templates/config.yaml) includes this setting.

### Codex enhancement requires `--remote unix://`

In Codex 0.167.0, CLI overrides such as `-c model_reasoning_effort="high"` and `-c check_for_update_on_startup=false` select an embedded app-server unless a remote endpoint is explicitly selected. This prevents [issue-runner-agent-codex](https://github.com/BuddyLabsCo/issue-runner-agent-codex) from monitoring the interactive session through the shared app-server.

When using this enhancement with these overrides, add `--remote unix://` to both Codex `start` and `resume` commands. The enhancement needs the same shared app-server as the interactive session for readiness checks and automatic recovery. The template includes both the remote endpoint and the update-check override in both commands.

## Troubleshooting
### Operator Pause

Runner pauses when an operation needs a decision, such as exhausted API/Git retries, resource creation failure, uncertain command delivery, or rejected enhancement readiness. Inspect the reported target and any partial effects before pressing Enter to retry or continue. `q` or EOF cancels; Issue-scoped pauses also allow `s` to skip and retain that Issue's resources. Audit recovery retries logging only. Continuing an uncertain command does not replay it.

### Folder or hook trust blocks startup

Without an enhancement e.g. issue-runner-agent-codex, Runner waits the base startup delay and sends an identity-only Session Probe. Folder trust, hook trust, or native permissions will block the Agent session.  
Make sure there is no startup blockers when running your agent cli from the checkout folder configured in config.yaml.

### Continue a stopped conversation

AI session might stop midway requiring user input, you can always go to related tab and interact with AI there to resolve the blocker manually.

### Request an omitted handoff

Runner workflow is based on handoff file. It will monitor if handover file generated on required path, then it will know current ai session is over and move to next step.  
When the Agent finishes without a handoff, find the active absolute path in Runner's `handoff=` output or the task's `Handoff path:` line. Explicitly invoke the installed skill in that same native conversation using that Agent's skill syntax, for example:

```text
/issue-runner-handoff /absolute/project/handoffs/current-assignment.json
/issue-runner-handoff "D:\Runner Work\project\handoffs\current-assignment.json"
```

This might happen when context too huge causing AI forgets how to do the correct hand over as requested initially.

## Developing Core

Install the locked dependencies and use the existing checks:

```sh
npm ci                   # Install development dependencies
npm run build            # Compile JavaScript and declarations into dist/
npm run typecheck        # TypeScript diagnostics
node --test tests/run/cli-startup.test.ts # One focused workflow file
npm run check            # Formatting, lint, and typecheck
npm test                 # Full suite, including package installation checks
npm run test:workflow    # Agent and application scenarios
npm run test:adapters    # External boundaries and real Git
npm run test:package     # Pack/install in isolated consumer and global prefixes
npm run verify           # Static checks and full suite
```

`npm pack` builds through `prepack`. To check an existing candidate without repacking, set `RELEASE_TARBALL` to its absolute path and run `npm run release:accept`.

Core exports `runCli` and `CliOptions` from `issue-runner-core/cli`, and Terminal/Enhancement contracts from `issue-runner-core/terminal`. It has no executable, package-root entry, or public testing entry. Terminal packages depend on Core at runtime; enhancements can use a type-only development dependency.

Read the [public integration contract](docs/terminal-contract.md) for plugin behavior, [code architecture](https://github.com/BuddyLabsCo/issue-runner-core/blob/main/docs/code-architecture.md) for ownership and test placement, and [glossary](https://github.com/BuddyLabsCo/issue-runner-core/blob/main/GLOSSARY.md) for terminology. Package tests verify installed resources and public consumers without native Herdr or model calls. They do not replace real npm acceptance evidence. Documentation changes do not authorize a new publication; release decisions remain with the maintainer.
