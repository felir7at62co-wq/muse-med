---
kind: upgrade-guide
description: "Muse defers specialized tool definitions and gives newly created Bot teams separate coordinator and specialist presets."
---

# Muse tool discovery and Bot roles

English | [中文](guide.zh.md)

## Change

Muse Desktop initially presents its standard tools, Bot coordination tools, and a short directory of authorized capability groups. Discovery guidance recommends searching for specialized capabilities before building shell or web substitutes; it does not require a search or block execution. Specialized registered tools are discovered through `tool_search`; `tool_context` manages temporary loading and preferred tools. New teams use `bot-coordinator` for the main Bot and `short-drama` for the Muse specialist. Existing Sessions retain their original preset, workspace and history. Tool selection does not grant permissions or erase historical tool data.

Search recognizes exact tool names and configured aliases within longer queries. A query with no matches in its requested capability, or an explicit name or alias outside that group, searches the full authorized registry and reports `global_fallback: true`. Registered tools without a configured group appear under the reserved `uncategorized` capability. Use the returned `next_offset` with the same query and capability to continue browsing; `omitted` counts all matches outside the current page.

## Migration

1. Preserve existing home and Session data when upgrading. No account or workspace migration is required.
2. If maintaining a custom Desktop composition, mount `@deepseek-ai/dsh-tool-discovery` once on the Host and configure `alwaysLoad` and `capabilities`; optional `maxDirectoryChars` limits the initial directory JSON (default `2000`, range `256`–`16384`). Do not mount duplicate services in presets.
3. Use `tool_search` to find specialized tools. Use `tool_context` with `status`, `load`, `pin`, `release` or `unpin` to inspect or change selections. Successful Bot preferences apply to future conversation parts; temporary loading belongs to the current Session.
4. Start a new team to use the new coordinator role. An existing conversation is not silently changed to a different preset. Confirm the initial capability directory, tool status, and the Bot's preset before starting work. Loading or pinning tools must not duplicate or rewrite the unchanged directory.
5. Custom capability ids must not use the reserved `uncategorized` id. Search consumers may read the additive `search_scope`, `global_fallback`, and optional `next_offset` result fields; previous calls without an offset remain valid.

See the [tool discovery reference](../../../../packages/core/tool-discovery/README.md) for provider-dependent caching and persistence behavior.
