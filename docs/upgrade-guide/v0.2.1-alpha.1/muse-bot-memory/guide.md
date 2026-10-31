---
kind: upgrade-guide
description: "Muse Desktop removes its Hindsight plugin and tool in favor of built-in Bot memory."
---
# Muse Desktop uses built-in Bot memory

English | [中文](guide.zh.md)

## Change

Muse Desktop no longer exports `@deepseek-ai/dsh-desktop-host/hindsight` or registers `muse-hindsight` and `hindsight_memory`. Muse Bot uses its built-in memory without a separately installed service. Existing Bot notes remain in place. Hindsight connection files, daemon configuration and stored memories are not read, deleted or automatically imported.

## Migration

1. Remove `muse-hindsight` rows and imports of `@deepseek-ai/dsh-desktop-host/hindsight` from custom `cordis.yml` patches. Remove `hindsight_memory` from custom tool pins and prompts.
2. Use Muse Bot's memory panel or its `remember`, `recall` and `forget` tools for persistent notes. If a preference exists only in Hindsight, confirm that preference before adding it to the appropriate Bot or team memory; no automatic conversion occurs.
3. Open a new Bot conversation and confirm its existing notes are available. Built-in memory requires no Hindsight connection file or service. Independently installed Hindsight services and their data remain under their owner's control.
