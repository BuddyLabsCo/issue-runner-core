# Release Core

Core releases stable versions from `main`. Automation maintains one `auto-release` pull request; your manual squash or rebase merge authorizes publication. Merge commits cannot publish. The first stable manifest and both root lockfile versions are `0.1.0`.

## Configure the repository

Install a GitHub App on `BuddyLabsCo/issue-runner-core` with repository contents and pull request read/write permissions. Set repository secrets `APP_ID` and `APP_PRIVATE_KEY` for that installation. Proposal automation uses its token so the Release PR runs normal CI. It never approves or merges the PR.

The proposal defaults to the next patch after the latest stable `v<version>` tag. For the first release, it proposes `0.1.0`. You can select a higher minor or major version in the proposal's manifest and both lockfile version fields. Refresh preserves your selection. Workflow-only changes do not open a proposal, but refresh an existing one. A release-only merge never opens the next proposal. Changelog entries and release notes follow the pinned source process.

## Verify and publish the candidate

`publish-release.yml` reruns Core's existing Ubuntu/Windows CI at the actual merged commit. The publishing job packs that commit and passes the candidate through `RELEASE_TARBALL` to `npm run release:accept`. The check installs those bytes in isolated consumer and global prefixes, verifies public JavaScript and type entries, inert CLI import, contract versions, bundled resources, command integration and enhancement discovery. Core declares no executable. Development package tests pack locally only when no candidate is supplied.

The workflow retains the verified tarball and adjacent JSON identity as `verified-core-release` for 90 days. Its log and job summary identify the workflow run, release commit, version, candidate path, integrity and Trusted Publisher settings. Download and preserve this artifact before retention expires.

Routine publication requests GitHub Actions OpenID Connect (OIDC) identity and publishes with public access and the stable `latest` tag. It uses isolated npm configuration and strips legacy token credentials. There is no stored npm publishing token fallback. Publication then creates `v<version>` at the release commit and the matching GitHub Release using the Release PR notes.

## Bootstrap a missing npm package

A missing `issue-runner-core` package stops publication after verification and artifact retention. No placeholder package is needed.

1. Open the failed publication run and download `verified-core-release`. Check its JSON identity against the run, commit, version and tarball SHA-512 integrity. Keep the downloaded bytes unchanged.
2. With your npm login and two-factor authentication, publish that exact substantive tarball: `npm publish ./issue-runner-core-0.1.0.tgz --access public --tag latest`. Do not rebuild it.
3. Configure the package's Trusted Publisher with GitHub organization `BuddyLabsCo`, repository `issue-runner-core`, workflow filename `publish-release.yml`, and no environment. Allow direct publishing for this publisher. Configure it close to the first OIDC publication; the release decision records npm's initial trust window.
4. Rerun the original publication workflow. It compares registry integrity and `latest` with the verified candidate, then completes the missing tag and Release. A mismatching artifact or identity stops recovery.

## Recover a partial publication

Read the reported completed stages before retrying the original run. Recovery reuses matching registry contents, local/remote tag targets, and an already published Release. It pushes an existing matching local tag, creates a missing tag or Release, and publishes a matching draft Release. Conflicting bytes, tag targets, Release identities or registry `latest` stop recovery without overwriting them. A registry/network error is not evidence that a package is absent.

Proposal and publication retain the source's separate concurrency groups. Versions come from completed tags, so a main push during partial publication can prepare another proposal for the same version. Finish recovery before advancing another release. This implementation does not redesign that source limitation.

## Record acceptance separately

Implementation readiness means local static checks, focused release tests and Core package verification pass. Release tests substitute external services; they do not prove npm ownership, GitHub permissions or OIDC authorization.

Keep separate evidence for the human bootstrap, a subsequent genuine OIDC Core publication, and real npm installation/operation acceptance. Do not manufacture an empty release for OIDC proof. Existing consumer CI owns exact-version npm consumption evidence; dependency updates and consumer releases remain independent. No Core registry-install suite or downstream publishing is added here.

## Source and decisions

The scripts, fixtures and workflow mechanics derive from [Sandcastle commit 55c66eb](https://github.com/BuddyLabsCo/sandcastle-runner/tree/55c66eb88ba94272a51563666fe2ca19ece38224/scripts/release). Core-specific adaptations follow the [release process decision](https://github.com/BuddyLabsCo/issue-runner-core/issues/294#issuecomment-6665320414), [Core publication decision](https://github.com/BuddyLabsCo/issue-runner-core/issues/295#issuecomment-6665609887) and [implementation ticket](https://github.com/BuddyLabsCo/issue-runner-core/issues/311).
