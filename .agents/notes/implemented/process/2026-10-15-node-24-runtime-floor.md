# Agent Note: Node runtime floor and compatibility coverage

Status: implemented

English | [中文](2026-10-15-node-24-runtime-floor.zh.md)

## Problem

The root `engines.node` range promises that the installed workspace supports each admitted runtime. Its minimum must cover both the runtime APIs DSH uses and the declared requirements of installed dependencies. Otherwise strict installation can reject a supported version before DSH starts.

## Decision

Set `engines.node` to `^24.15.0 || >=26.0.0`. Node 24.15 is the minimum for the 24.x line. The plugin repository parser uses hosted-git-info 10.1.1, whose supported runtime range excludes earlier Node 24 versions and Node 25. This supersedes the [Node 22.19 floor](../../archived/process/2026-07-06-node-engine-floor.md). Migration instructions live in the [upgrade guide](../../../../docs/upgrade-guide/v0.2.2-rc.2/node-24-15/guide.md).

The primary Node 24 jobs own complete typechecking and unit coverage. Focused compatibility jobs run on pinned Node 24.15 and Node 26. Pinning the minimum avoids replacing its coverage with another floating Node 24 job. Both supported lines use the v2 private module loader introduced in Node 24.12; compatibility helpers retain older-loader fixtures for released hosts without promising installation on those hosts.

The Node 24.15 compatibility job also builds artifacts and checks that the shipped Web CLI starts and disposes with full-text Session search disabled. Command-entrypoint, source-worker, Zstandard, source-launch, profile-resolution, and jsdom-storage checks run on both compatibility versions. Real-API e2e jobs stay on Node 24 because they validate provider integration.

Node declaration versions follow the APIs used by each compiler program; dependency declarations can require a newer type package than the runtime minimum. Runtime compatibility jobs remain the authority for executable API availability. The independently published native addon has its own runtime and type support policy.

## Consequences

- Node 22, Node 24.0–24.14, and Node 25 installations must upgrade before running DSH. Packaged applications with an embedded runtime do not require a system Node upgrade.
- Supported runtimes provide `node:sqlite` and native TypeScript stripping without opt-in flags. The source CLI still uses its declared `tsx/esm` launcher.
- The compatibility graph retains the supported v2 loader and retained fixtures for older hosts.
- A future runtime-floor change updates `engines.node`, compatibility jobs, current documentation, this note, and an upgrade guide together.

## Alternatives considered

- **Keep Node 22 support.** It excludes the OAR library from the supported installation.
- **Use OAR’s declared minimum of Node 24.0.** Existing script entrypoints depend on `import.meta.main`, which Node 24.0 lacks. A dependency minimum alone does not establish the application minimum.
- **Test only the latest Node 24.** It does not exercise the minimum supported version.
- **Raise Node declarations ahead of the minimum.** It allows code to compile against APIs that a supported runtime can lack.
