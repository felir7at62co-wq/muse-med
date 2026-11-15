---
kind: upgrade-guide
description: "Muse Desktop removes its Hindsight plugin and preserves existing memory files without loading a replacement Bot service."
---
# Muse Desktop retires memory services

English | [中文](guide.zh.md)

## Change

Muse Desktop no longer exports `@deepseek-ai/dsh-desktop-host/hindsight` or registers `muse-hindsight` and `hindsight_memory`. The bundled Bot service and memory interface are also inactive; [ordinary Sessions](../muse-session-product/guide.md) are the product entry. Existing Bot notes remain in place. Hindsight connection files, daemon configuration and stored memories are not read, deleted or automatically imported.

## Migration

1. Remove `muse-hindsight` rows and imports of `@deepseek-ai/dsh-desktop-host/hindsight` from custom `cordis.yml` patches. Remove `hindsight_memory` from custom tool pins and prompts.
2. Keep Bot and Hindsight memory files with their original configuration. Ordinary Sessions do not automatically import them. Copy only deliberately selected, reviewed information into a project file when needed.
3. Open an ordinary conversation and confirm that existing Session history remains available. The product does not require a Hindsight daemon. Independently installed services and their data remain under their owner's control.
