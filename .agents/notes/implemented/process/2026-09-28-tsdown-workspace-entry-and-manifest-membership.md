# Agent Note: The root tsdown entry is a workspace default, and workspace membership is manifest-backed

Status: implemented

English | [中文](2026-09-28-tsdown-workspace-entry-and-manifest-membership.zh.md)

## Problem

A synced worktree failed `pnpm run build:lib` with

```
Error: [@deepseek-ai/dsh-root] Cannot find entry: ["lib/types/{index,invariant,startup}.js"]
```

while `main` passed the same command, and no line has a root `src/`. The message reads as a defect in [the root tsdown entry](../../../../tsdown.config.ts): the root package demanding artifacts nothing can produce, which invites the symmetric fix of demanding nothing. Both halves of that reading are wrong — the root package is not a build target, and that entry is not the root's own.

## Decision

`entry: ['lib/types/{index,invariant,startup}.js']` is the **workspace-wide default entry**. tsdown merges the root config into every workspace member's config, and each member resolves the glob against its own directory, so it means "bundle whatever `tsc -b` emitted into this package's `lib/types`". 196 of the 312 enumerated directories have no `tsdown.config.ts` of their own and depend on it. The Client face's `''` is the same option carrying no default: `resolveConfig` drops every member that declares no entry of its own.

The root package is never built. `workspace.include` enumerates `vendor/*`, `packages/*/*`, and three application directories; the root is not among them, the root `tsconfig.host.json` is a `noEmit` aggregate over tests and scripts, and the root manifest is `private` with no entry points.

## Membership is directory-based

`workspace.include` is resolved with `onlyDirectories: true` and never consults a manifest. A directory under `packages/*/*` or `vendor/*` that owns no `package.json` — a stale or half-scaffolded package directory — still becomes a target; the inherited entry resolves inside it, matches nothing, and `resolveEntry` fails. The label comes from `readPackageJson(cwd)`, which walks up to the repository manifest, so the failure names `@deepseek-ai/dsh-root` while the root package contributed nothing to it.

[`tsdown-workspace.spec.ts`](../../../../scripts/tsdown-workspace.spec.ts) asserts that every directory the wildcard members enumerate owns a manifest, and names the directory at fault otherwise.

## Alternatives considered

**Give the Host face an empty entry, as the Client face has.** It reads as the symmetric fix, and it deletes the default for the 196 directories that rely on it: with a falsy entry the root config no longer admits its inheritors, so those packages leave the build instead of building from another entry.

**Add a root `src/`.** The root package ships nothing, so the tree would exist only to satisfy a glob, and the entry would bundle output no consumer imports.

**Skip tsdown or Typert for the Host face to make the command green.** The Host pass emits each member's bundle and the Typert artifacts the Client face consumes; skipping it moves the failure into the client build without removing it.

## Consequences

A stale directory still stops the build, and the guard runs only with the test suite while `build:official` → `build:lib` does not run it. What changed is that the failure is documented where the entry lives, and that a developer running tests is told which directory has no manifest instead of being pointed at the root package.
