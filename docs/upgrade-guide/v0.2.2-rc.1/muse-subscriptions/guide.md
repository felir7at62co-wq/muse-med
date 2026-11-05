---
kind: upgrade-guide
description: "Muse replaces the default Codex subscription bundle with dsh-plugin-subscriptions and preserves the old private data."
---

# Muse subscription provider replacement

English | [中文](guide.zh.md)

## Change

Muse Desktop selects `dsh-plugin-subscriptions` instead of the default `dsh-codex-subscription` bundle. Existing subscription settings, provider identifiers and enhanced attachment interfaces are not interchangeable. The old source pin remains available for archive restoration, but it is excluded from default builds.

Session logs, attached source files and old credentials remain on disk. Old enhanced preview, canvas, PSD, annotation state and enhancement preferences cannot be imported directly. Archived recovery builds retain the old Codex native-CLI subagent path; the replacement uses ordinary DSH subagents. Keeping old data does not activate archived interfaces or verify subscription access.

## Migration

1. Finish active work and back up the active Harness home, Electron userData, profile `package.json` and `cordis.patch.yml`. Include the existing subscription credentials and attachment data. Keep the original backup private and unchanged.
2. Use the updated Muse Desktop profile, which selects the `dsh-plugin-subscriptions` bundle entry `llm-subscriptions`. Managed upgrades back up the profile and retain old preference rows and configuration with literal `disabled: true` tombstones. Custom compositions must replace the active old entry rather than activating both bundles. Preserve the original files for recovery.
3. On first activation, the local importer copies only the previous active Codex OAuth account into `$DSH_HOME/plugins/subscriptions/auth.json`, after checking token fields, account identity and any declared OAuth client. Both retained providers use the same OAuth client, but real login and refresh remain unverified. Existing replacement Codex data is never overwritten; old credentials remain unchanged. Other old accounts require login in the new settings page. Completion is recorded at `$DSH_HOME/plugins/subscriptions/muse-codex-migration-v1.json`, preventing automatic reimport after logout. Failed imports persist `manual-login-required` and leave settings available for explicit login. If the marker cannot be saved, the status warns that automatic import may retry after restart. Do not delete the marker or copy whole credential files to reconnect. Keyless checks do not establish real login or inference.
4. Retain the old enhanced preview, PSD and annotation files with the archived application. Add an existing exported image as an ordinary attachment when needed; this does not transfer editable canvas or annotation state. Do not remove old Session files to hide unavailable presentation features.
5. Open a historical conversation and verify its text and source attachments. Check the selected provider and model, reconnect or reselect where necessary, then verify image selection, paste, actual cross-window drop and a real model request separately. Preserve the original archive and credentials until these checks complete.
