---
description: "Configure overlapping capability groups, on-demand tool discovery, Chinese and English metadata search, and session-restored loading without changing permissions."
kind: "package-reference"
---

# @deepseek-ai/dsh-tool-discovery

English | [中文](README.zh.md)

## Summary

Keep specialized tool definitions out of the initial request while showing agents a short authorized capability directory and discovery guidance. Select constant tools, browse groups or search metadata in Chinese or English, and expose matching definitions on the next step. Successful discoveries survive session restoration without granting additional permissions. Discovery adds a search step, and lexical matching does not guarantee that the most suitable capability will be found.

## Table of Contents

- [Use this package](#use-this-package)
- [Understand the implementation](#understand-the-implementation)
- [Further Exploration](#further-exploration)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)
- [Dev Note](#dev-note)

-----

<a id="use-this-package"></a>
## Use this package

Mount this plugin once in the Host composition that provides `tools`, `agents`, and `sessionProjections`. It registers `tool_search` and `tool_context` and selects model-facing definitions through the [tool registry](../tools/README.md#select-model-facing-definitions); it does not replace tool implementations or authorization.

### Configure constant tools and capability groups

```yaml
- id: tool-discovery
  name: '@deepseek-ai/dsh-tool-discovery'
  config:
    alwaysLoad: [read, write, edit, skill]
    keywords:
      video_inspect: [抽帧, 人物动作, 切镜]
    capabilities:
      - id: video
        title: 视频理解
        description: 提取对白、查看画面与人物动作
        tools: [audio_transcribe, video_inspect, video_ocr]
      - id: screenplay
        title: 剧本与分镜
        description: 编写剧本、核对动作与整理分镜
        tools: [manuscript_revision, drama_*, video_inspect]
```

`alwaysLoad` contains exact tool names and may name providers that register later. `tool_search` and `tool_context` are always included. Only tools currently authorized for the calling agent are presented or searchable; naming a restricted tool here does not grant access.

| Field | Default | Meaning |
|---|---|---|
| `alwaysLoad` | required | Definitions presented before a search |
| `maxResults` | `8` | Maximum tools loaded by one search, from 1 to 32 |
| `maxDescriptionChars` | `320` | Unicode-character limit for each result description, from 1 to 2048 |
| `k1` | `1.2` | BM25 term-frequency saturation, from 0.01 to 10 |
| `b` | `0.75` | BM25 document-length normalization, from 0 to 1 |
| `keywords` | `{}` | Additional searchable phrases keyed by exact tool name |
| `capabilities` | `[]` | Overlapping groups with `id`, `title`, `description`, and tool-name patterns |
| `maxResultChars` | `6000` | Complete serialized JSON result budget, from 256 to 65536 characters |
| `maxDirectoryChars` | `2000` | Initial directory JSON budget, excluding fixed guidance, from 256 to 16384 characters |

Each capability has a nonempty unique `id`. Its `tools` entries are exact names or prefixes with one trailing `*`; other wildcard positions are rejected. A tool may belong to several groups, as `video_inspect` does above. Groups describe capabilities rather than permission partitions: global search can cross them, and uncategorized authorized tools remain searchable. The directory omits groups with no currently authorized tools and counts each group's matching tools independently. The initial discovery section lists ids, titles, and first-line description previews without loading tools. It preserves complete category names before sharing the remaining description budget and reports omitted categories. Global search still covers groups missing from a cropped directory.

The generated [configuration catalog](../../../docs/config-catalog.md#deepseek-aidsh-tool-discovery) is the exhaustive configuration reference.

### Browse capabilities or search tools

`tool_search` accepts optional `query`, `capability`, and `limit` arguments. Queries search authorized names, descriptions, parameter names and descriptions, string enum values, configured keywords, and matching capability ids and titles. Exact normalized tool names take priority; other results use lexical relevance with deterministic name ordering for ties. A miss returns no unrelated fallback tools, so the agent can try another query.

| Arguments | Result |
|---|---|
| Neither `query` nor `capability` | List capability summaries without loading tools |
| `capability` only | Browse that group's tools and load up to the configured or requested limit |
| `query` and `capability` | Search and load matching tools within that group |
| `query` only | Search across all authorized tools, including uncategorized tools |

An unknown capability id returns the available directory without loading tools. Without configured groups, query searches still cover the full authorized catalog. `limit` must be between 1 and `maxResults`, including directory requests.

Results contain `loaded` entries with names, bounded description previews, and all matching capability ids; `capabilities` contains directory entries with `id`, `title`, `description`, and current authorized `tool_count`. `matched` counts matching tools before limits, `omitted` counts matching tools not returned, and `omitted_capabilities` counts directory entries not returned. The complete serialized JSON stays within `maxResultChars`; descriptions may become empty and entries may be omitted to keep names and JSON intact. Narrow a query when results are omitted.

Only names present in a successful result's `loaded` array become selected. The next assembly exposes those tools' current full definitions, including argument schemas. Loading persists for that session instead of expiring after each call. Discovery itself does not execute tools, change existing approvals, or prevent an already-authorized tool from executing before discovery.

### Manage session loading and Bot preferences

`tool_context` accepts `operation` and optional exact-name `tools`. Constant tools cannot be edited. `load` and `pin` require currently authorized tools; releases can also remove dormant stored names. Changes select definitions for the next request; they do not execute tools or erase earlier definitions and results from model history.

| Operation | Effect |
|---|---|
| `status` | Read selected and preferred names; omit `tools` |
| `load` | Select names for this session |
| `pin` | Select names and save the future-session preference |
| `release` | Remove current loading and the preference; search can reload them |
| `unpin` | Remove the future-session preference and retain current loading |

Successful receipts identify the applied operation and complete affected names. Bounded `loaded` and `pinned` previews include `omitted_loaded` and `omitted_pinned` counts. When the affected-name receipt itself exceeds `maxResultChars`, the operation fails before saving; submit fewer names. Invalid or unavailable additions and constant-tool edits fail without partial changes.

Without an external owner, pins are session-derived and survive resume or history-seeded forks. To carry them into a Bot's fresh sessions, register `ctx.toolDiscovery.registerResidency({ matches, read, write })`. The provider owns stored-name parsing and durable writes. `read(agent)` returns complete preferred names; `write(agent, names)` saves their replacement. Unavailable stored names remain dormant and survive unrelated edits. Multiple matching owners fail explicitly. Registration is reversible; late registration or external edits require `await ctx.toolDiscovery.refresh(agent)`. Agent creation awaits the initial read before its first assembly. A failed owner write returns a failed tool result and leaves current selection unchanged.

`ctx.toolDiscovery.state(agent)` reads detached, authorized `loaded` and `pinned` arrays. The service and catalog are shared; selections are per agent, and a provider decides which Bot owns each agent. A role prompt does not grant tools.

### Restore and isolate loading

A session projection derives loading and preferences from successful search and management results, including PTC dispatches. Restored sessions rebuild those names from their logs; a fork containing that history inherits them. A new child session starts with its own discoveries, and its parent agent's selection does not cap what the child can load. Current authorization still applies when definitions are presented or executed. Unloading the plugin removes its search tool and presentation filters; original capabilities remain registered.

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

The MIT-licensed index independently implements standard BM25 in TypeScript. Chinese word segmentation and identifier normalization support local metadata lookup without an additional language-model request. Search reads the calling agent's authorized registry and reuses an index while that catalog is unchanged. The session projection retains loaded names rather than executable definitions, so current registration and authorization remain authoritative.

| File | Responsibility |
|---|---|
| [`src/index.ts`](src/index.ts) | Search tool, configuration, durable loading projection, and scoped presentation |
| [`src/search.ts`](src/search.ts) | Chinese and English tokenization, metadata indexing, and BM25 ranking |
| [`src/capabilities.ts`](src/capabilities.ts) | Overlapping group membership and authorized directory summaries |
| [`src/guidance.ts`](src/guidance.ts) | Stable discovery guidance and the bounded initial directory |
| [`src/residency.ts`](src/residency.ts) | Per-agent preference service and optional Bot-owned persistence |

</details>

-----

<a id="further-exploration"></a>
## Further Exploration

- [Tool registry](../tools/README.md) — presentation selection and execution permissions.
- [Session projections](../../session/session-projection/README.md) — rebuilding derived state from session events.
- [LLM adapters](../../llm/llm/README.md) — provider-specific tool update behavior.
- [Codex reference fork](https://github.com/felir7at62co-wq/codex) — upstream architecture reference, not a runtime dependency.
- [Referenced Codex discovery guidance](https://github.com/openai/codex/blob/c6fce1caceaae6c4b2896e5c5ae456b5be3bf501/codex-rs/core/src/tools/handlers/tool_search_spec.rs) — upstream reference for discovery instructions and source summaries; [NOTICE](NOTICE) records attribution.

-----

<a id="model-experience"></a>
## Model Experience

### Search tool and selected definitions

#### What the model sees

The model initially sees authorized constant tools, `tool_search`, `tool_context`, and one `tools:discovery` prompt section. The section explains deferred capabilities, recommends searching before building shell or web substitutes, and includes the bounded authorized directory. Missing definitions or local scripts do not establish capability absence. The tool definition describes query and browsing operations without repeating the directory. Search results select complete definitions for the next step; native schemas and generated PTC SDK declarations share that selection. Existing system-message logging preserves the section for replay. A complete prompt override can suppress this section.

#### Token effect

Unselected registry definitions are omitted from the current assembly. Fixed guidance and a bounded directory appear before any discovery call. Each directory or discovery request adds a call and bounded JSON result; only discovery accumulates loaded definitions within the session. Selected tools retain their full argument schemas. Existing history is not erased by this plugin.

#### KV Cache effect

Loading, pinning, and releasing tools leave the discovery section unchanged while the authorized catalog and configuration remain unchanged. Permission or capability-metadata changes can update that section. Selected definitions still change request headers; cache reuse depends on the model adapter, so this plugin does not guarantee append-only updates or cache preservation across providers.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

These limits distinguish discovery from access control and semantic task routing.

- **Registry projection only:** independently contributed system-prompt sections and tool-schema providers are not filtered, so tool discovery alone does not remove all unrelated guidance.
- **Lexical retrieval:** Chinese segmentation, names, group metadata, and keywords improve matching but do not establish semantic relevance or task completion; an agent may need another query.
- **Agent-driven selection:** guidance does not force search, block shell use, or establish task accuracy. Loading persists until the agent releases it; no automatic task-stage classifier chooses tools. Cross-session Bot preferences require a registered persistence owner.
- **Provider-dependent caching:** smaller initial definitions do not establish lower total cost, latency, or better cache reuse for every model route.
- **Metadata lifecycle:** restored names use current definitions; the projection does not freeze an older schema or revive removed tools.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

None.

</details>
