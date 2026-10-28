---
kind: upgrade-guide
description: "Muse defers specialized tool definitions and gives newly created Bot teams separate coordinator and specialist presets."
---

# Muse tool discovery and Bot roles

English | [中文](guide.zh.md)

## Change

Muse Desktop initially presents its standard tools and Bot coordination tools. Specialized registered tools are discovered through `tool_search`; `tool_context` manages temporary loading and preferred tools. New teams use `bot-coordinator` for the main Bot and `short-drama` for the Muse specialist. Existing Sessions retain their original preset, workspace and history. Tool selection does not grant permissions or erase historical tool data.

## Migration

1. Preserve existing home and Session data when upgrading. No account or workspace migration is required.
2. If maintaining a custom Desktop composition, mount `@deepseek-ai/dsh-tool-discovery` once on the Host and configure `alwaysLoad` and `capabilities`; do not mount duplicate services in presets.
3. Use `tool_search` to find specialized tools. Use `tool_context` with `status`, `load`, `pin`, `release` or `unpin` to inspect or change selections. Successful Bot preferences apply to future conversation parts; temporary loading belongs to the current Session.
4. Start a new team to use the new coordinator role. An existing conversation is not silently changed to a different preset. Confirm tool status and the Bot's preset before starting work.

See the [tool discovery reference](../../../../packages/core/tool-discovery/README.md) for provider-dependent caching and persistence behavior.
