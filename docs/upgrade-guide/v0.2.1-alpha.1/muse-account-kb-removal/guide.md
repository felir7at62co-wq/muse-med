---
kind: upgrade-guide
description: "Muse account activation no longer starts its built-in knowledge-base MCP server or registers its tools."
---

# Built-in Muse account knowledge-base MCP is removed

English | [中文](guide.zh.md)

## Change

`@deepseek-ai/dsh-muse-account` no longer starts the `muse-account` MCP sidecar. The `mcp__muse-account__*` tool namespace, including account status and `muse_kb_*` operations, is absent from new tool discovery. The package also removes its `src/kb.ts` and `src/mcp-server.ts` modules and their generated entries.

Account sign-in, account-authorized models, direct model transport, speech transcription, feedback, web search and desktop remote access retain their account interfaces. User-configured MCP servers remain independently configured. This Desktop change does not delete or migrate cloud vaults, documents or local Session history, and does not deploy a gateway change.

## Migration

1. Restart the Host with the updated account package. Remove custom `cordis.yml` or patch rows that manually launch this package's former `lib/types/mcp-server.js` entry; the updated package does not provide that program.
2. Remove instructions and workflows that require `mcp__muse-account__*` tools. For account status, use **Settings → MUSE Account** or the existing `museAccount.status` Remote method. If a workflow needs an external knowledge service, configure its own supported server through the [MCP client](../../../../packages/mcp/mcp-client/README.md) with that service's authorization.
3. Confirm that account sign-in and the model picker still work, and that new tool discovery contains no `mcp__muse-account__*` names. Confirm separately that any user-configured MCP tools remain available. Keep existing cloud data under its current access rules; no data deletion is required for this migration.
