# Terminal contract v1

This contract-only development package provides JavaScript and TypeScript
declarations at `issue-runner-core/terminal`. It has no Runner executable,
plugin loader, workflow, or terminal implementation. No package publication or
real Core/Herdr acceptance is implied.

The public boundary follows the accepted
[terminal decision](https://github.com/BuddyLabsCo/issue-runner-core/issues/8#issuecomment-6506349277),
[testing amendment](https://github.com/BuddyLabsCo/issue-runner-core/issues/10#issuecomment-6507842894),
and [development order](https://github.com/BuddyLabsCo/issue-runner-core/issues/11#issuecomment-6518349773).
Contract version `1` is independent of the npm version `0.0.0-contract.1`.

## Build and identify a development artifact

Use Node.js 22.18 or later within 22.x and npm 11.x. The lockfile pins the
TypeScript build dependency; this package has no runtime dependencies.
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
not require a Runner or Herdr source checkout.

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

Declarations do not replace the future loader's runtime checks of the selected
module, exact contract version, initialized factory result, and three methods.

## Verification limits and eventual installation

`npm test` packs Core, installs that artifact into a separate temporary consumer
directory (including a space in its path), imports the runtime entry, checks
the package's file/export surface, and compiles a type-only plugin consumer
against the installed declarations. These checks require no Herdr, Agent
account, or model call.

The full product will support Core and its selected plugin installed globally
in the same active npm environment/prefix, including custom prefixes:

```sh
npm install -g issue-runner-core issue-runner-herdr
issue-runner run --env herdr
```

These commands describe future product usage. This contract artifact does not
provide `issue-runner`, configuration parsing, or the manually installed handoff
skill required by the future workflow. Project-local/npx and mixed-prefix
product installations are outside the agreed support policy. Project
configuration will remain `<launch-directory>/<project>/config.yaml`.

The required full-product CI matrix is Ubuntu and Windows with Node 22.18+
within 22.x/npm 11.x. Paths and child processes here use portable Node APIs;
portable code does not establish tested macOS behavior. Package tests do not
establish actual terminal delivery, native Agent behavior, or joint acceptance.
