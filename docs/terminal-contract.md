# Terminal contract v1

This development package provides JavaScript and TypeScript declarations at
`issue-runner-core/terminal`, plus the CLI startup and empty-parent slice
described in [configuration and startup](configuration.md). It includes a global
plugin loader, with no built-in terminal implementation. No package publication
or real Core/Herdr acceptance is implied.

The public boundary follows the accepted
[terminal decision](https://github.com/BuddyLabsCo/issue-runner-core/issues/8#issuecomment-6506349277),
[testing amendment](https://github.com/BuddyLabsCo/issue-runner-core/issues/10#issuecomment-6507842894),
and [development order](https://github.com/BuddyLabsCo/issue-runner-core/issues/11#issuecomment-6518349773).
Contract version `1` is independent of the npm version `0.0.0-contract.1`.

## Build and identify a development artifact

Use Node.js 22.18.0 or later and npm 11 or later, including subsequent major versions.
The lockfile pins the TypeScript build dependency.
The CLI uses the source's `cac` and `yaml` parsers.
From the Core checkout:

```sh
npm ci
npm run typecheck
npm test
npm pack --json --pack-destination artifacts
```

`npm pack` builds the JavaScript and declarations through `prepack`. Its JSON
output records the filename, version, SHA-1 `shasum`, SHA-512 `integrity`, and
packaged files. Save that output alongside the tarball when handing it to Herdr;
the repository records the initial artifact in
`artifacts/terminal-contract-v1.json`. The tarball itself is a local build
output, not a published package. Repacking unchanged package contents with the
same toolchain reproduces its identity. Git attributes and compiler output use
LF line endings so Windows checkout defaults do not change packaged bytes.

Copy the tarball to the independent plugin repository and install it as a
development dependency:

```sh
npm install --save-dev ../artifacts/issue-runner-core-0.0.0-contract.1.tgz
```

Use the actual tarball's portable relative or absolute path, including quotes
when it contains spaces. Keep its identity and the plugin lockfile together.
This development-only installation supports type-only consumption; it does
not require a Runner or Herdr source checkout. Product execution uses global
installation as described below.

```typescript
import type {
  CreateTabOptions,
  TabHandle,
  TerminalPlugin,
  TerminalPluginModule,
} from "issue-runner-core/terminal";
```

The same public entry supports the runtime import:

```javascript
import { terminalContractVersion } from "issue-runner-core/terminal";
```

There is no package-root entry, source-internal import, shared receiver, or
`issue-runner-core/terminal/testing` entry.

## Public types

```typescript
export const terminalContractVersion = 1 as const;

export type TabHandle = object;

export interface CreateTabOptions {
  cwd: string;
  env: Readonly<Record<string, string>>;
  label: string;
}

export interface TerminalPlugin {
  createTab(options: CreateTabOptions): Promise<TabHandle>;
  submitText(tab: TabHandle, text: string, submitKey?: string): Promise<void>;
  closeTab(tab: TabHandle): Promise<void>;
}

export interface TerminalPluginModule {
  readonly contractVersion: typeof terminalContractVersion;
  createTerminalPlugin(): Promise<TerminalPlugin>;
}
```

A plugin's public module exports named `contractVersion = 1` and an
asynchronous, zero-argument `createTerminalPlugin` factory. It initializes from
validated inherited host context and keeps native identities private.
Ambiguous host context fails initialization. There is no plugin-options object.

`TabHandle` is an opaque capability owned by one initialized plugin instance.
Core must not inspect, serialize, persist, or reconstruct it. It is distinct
from the native Agent conversation reference.

`createTab` creates a new owned Runner Tab in the absolute `cwd`, applying `env`
as a readonly string overlay on the inherited environment and using `label`
for display. It does not start an Agent or prove readiness. Invalid context or
unsupported environment application must fail rather than redirect silently.

`submitText` transports complete canonical-LF text, preserving Unicode, blank
lines, indentation, quotes, and literal characters. Each call inputs the whole
body, sends mandatory Right, then sends the final logical submission chord.
Enter is the default; the requested Shift+Enter case is also required.
Unsupported chords reject rather than fall back. Transport success does not
prove Agent acceptance or completion. Core owns command/session substitution,
startup delays, Probe and result validation, retries, and cancellation.

`closeTab` targets only the owned logical tab. Foreign handles, unknown targets,
and backend errors reject; a target known to be absent may close successfully.
Closing does not establish process or descendant settlement. Plugin operations
use finite backend I/O bounds and reject with actionable errors. They do not
silently replay input or select replacement targets. Core serializes operations
on each handle and may use independent handles concurrently.

Declarations do not replace the loader's runtime checks of the selected
module, exact contract version, initialized factory result, and three methods.
Core awaits the selected module's zero-argument factory before workflow startup;
default-only exports, string versions such as `"1"`, missing/non-callable methods,
and initialization rejection are startup errors. The error names the selected
plugin and preserves its installation, import, compatibility, or host-context
failure. Core neither initializes unrelated plugins nor installs a replacement.

## Verification limits and global installation

Run `npm run test:package` for the package checks; `npm test` includes them too.
These checks build and pack Core, then install its tarball into a temporary
consumer directory to verify the public JavaScript entry and declarations.
They also pack a private fake plugin and install both tarballs into the same
isolated custom npm global prefix. From a separate Launch Directory, they
invoke npm's generated `issue-runner` executable by absolute path for help,
version, and init. Hiding that executable must fail even with a local Core
consumer installed, so an ancestor's local executable cannot satisfy the check.
They verify all generated templates, installed purpose prompts, public types
from the global plugin directory, and the exact manually installable
`skills/issue-runner-handoff/SKILL.md` asset.

The loader checks await selected-plugin initialization and reject local,
other-prefix, linked-entry, PATH, NODE_PATH, and cache decoys. Temporary paths
include spaces and are removed after the checks, including on failure.
Installs use local tarballs and npm's offline dependency cache populated by
`npm ci`; they require no registry publication, Herdr, Agent account, or model call.

Product execution requires Core and its selected plugin installed globally
in the same active npm environment/prefix, including custom prefixes:

```sh
npm install -g issue-runner-core issue-runner-herdr
issue-runner run --project my-project --env herdr --parent 42
```

Registry publication is still future work; use built tarballs for development.
The artifact includes `issue-runner`, configuration parsing, and the
manually installed handoff skill. Project-local/npx and mixed-prefix product
installations are outside the agreed support policy. Project configuration remains
`<launch-directory>/<project>/config.yaml`.

The required full-product CI matrix is Ubuntu and Windows, currently pinned to
Node.js 22.18.0 and npm 11.6.2. Supported versions have no upper major bound.
Paths and child processes here use portable Node APIs;
portable code does not establish tested macOS behavior. Package tests do not
establish actual terminal delivery, native Agent behavior, or joint acceptance.
