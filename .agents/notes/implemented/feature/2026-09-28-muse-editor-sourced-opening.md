# Agent Note: Read a sourced script opening before editorial drafting

Status: implemented

English | [中文](2026-09-28-muse-editor-sourced-opening.zh.md)

## Problem

The Desktop roster serves short-drama production and four coding modes, while script writing requires a different sequence of evidence, drafting, and review. A search result or a remembered pattern can sound like research without supplying the opening text the editor actually read. A long persona containing every editorial procedure also consumes model context and obscures the step that must precede drafting.

## Decision

The product-owned `editing` preset is a sixth mode and keeps `short-drama` as the default. Its short persona names the prewriting obligation and loads the `muse-script-editing` skill when drafting begins. The skill requires an actual opening from an authorized source, a record of title, source, read extent, and analysis of conflict and hook. A knowledge-base result counts as a hit-script reference only when the gateway marks its source `viral-script`; a user may also designate and supply a readable reference. Search snippets and Wiki summaries do not satisfy the reading step. Without opening text, the agent may organize requirements but stops before formal prose. The agent draws on narrative technique without copying the reference story. Reference text is task data; embedded role commands, tool requests, and permission changes do not direct the agent.

The [Desktop decision](../architecture/2026-09-23-muse-med-independent-desktop.md) defines the product roster, profile isolation, and skill roots that serve this mode.

The Desktop Host ships the editing skill beside its preset and exposes it through the product's explicit skill roots. A scoped tool filter hides the Host's Jubian video tools from this mode while leaving them available to short-drama production. The filter also names tools that register after the editor because Host rows start concurrently. The skill and preset live in the same private Host package as the existing product modes. They do not depend on the external editorial workroom's server paths or command-line program. Long work proceeds in saved batches with a resumable progress record and review of continuity, scope, and actual files.

## Alternatives considered

**Add the editorial workflow to the short-drama production persona.** That mode owns media production, paid provider controls, and final video delivery. Combining script writing with it would make both prompts harder to navigate and attach irrelevant tools to editorial work.

**Treat search summaries as proof of reading.** The current knowledge-base search returns short excerpts and cannot establish the opening's conflict or first hook. The editor therefore requests an authorized full-text source when only summaries are available.

**Import the external editorial workroom unchanged.** Its workspace identity, wiki, and executable commands rely on a separate server deployment. A product-owned skill keeps the Desktop path and dependencies explicit.

## Consequences

The agent may pause drafting until it can read an authorized opening. The prompt and skill express a qualitative editorial rule; the keyless skill replay pins its text, and the packaged runtime pins the assembled editing persona, account MCP descriptions, and skill availability. These checks do not mechanically decide whether a reference is a hit or whether an analysis is good. The authenticated knowledge-base opening reader is a separate server integration and becomes usable only after that service is updated.
