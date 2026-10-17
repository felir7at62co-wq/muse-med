---
kind: upgrade-guide
description: "Muse removes Codex subscription and Agent Notes from its Desktop composition."
---
# Desktop settings plugin removal

English | [中文](guide.zh.md)

## Change

Muse no longer builds, bundles or activates Codex subscription by default. Existing Desktop profile bundle lists remove the retired subscription entry after backing up the manifest. The product overlay disables the Agent Notes settings page and its Host API; note files and subscription credentials remain on disk. Muse account access and knowledge-base tools remain available.

## Migration

1. Restart a newly built Muse Desktop instance to load the updated composition.
2. Use Muse account models or separately configured native providers. The Codex subscription settings entry is unavailable.
3. Access existing engineering-note files with a file editor; the Agent Notes settings entry is unavailable.
