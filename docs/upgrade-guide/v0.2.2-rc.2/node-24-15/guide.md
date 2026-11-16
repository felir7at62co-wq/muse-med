---
kind: upgrade-guide
description: Source installs and the CLI require Node.js 24.15 or newer in 24.x, or Node.js 26 and newer.
---

# Node.js 24.15 runtime minimum

English | [中文](guide.zh.md)

## Change

The root workspace and CLI accept `^24.15.0 || >=26.0.0` instead of `>=24.9.0`. Plugin repository parsing uses hosted-git-info 10.1.1, whose supported runtime range excludes earlier Node 24 releases and Node 25. Packaged Muse applications use their embedded runtime and require no system Node update.

## Migration

1. Before installing from source or updating the CLI, select Node.js 24.15 or newer within 24.x, or Node.js 26 and newer.
2. Run `node --version` and confirm that version matches `engines.node` in `package.json`.
3. Run `pnpm install --frozen-lockfile` and `pnpm run build`. Custom CI workflows must use the same supported range; the repository tests its minimum with Node.js 24.15.
