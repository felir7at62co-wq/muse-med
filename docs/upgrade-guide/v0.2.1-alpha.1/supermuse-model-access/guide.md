---
kind: upgrade-guide
description: Supermuse uses models from the signed-in Muse account and removes the bundled Codex subscription provider.
---

# Supermuse model access

English | [中文](guide.zh.md)

## Change

Supermuse routes model requests through the signed-in Muse account. The packaged application excludes the Codex subscription provider and its subagent runtime.

## Migration

1. Start Supermuse and sign in to Muse. If a saved model is unavailable, select a model supplied by your Muse account in Models settings.
2. Startup backs up the active profile's `package.json` before removing the Codex subscription bundle from `dsh.profile.bundles`. If you added a separate Codex entry to a personal Cordis patch, remove that entry before starting the patched profile. Startup retains separately installed npm dependencies and Session logs.
