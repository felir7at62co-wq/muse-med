# Agent Note: Outline-led Muse editorial drafting from verified sources

Status: implemented

English | [中文](2026-09-29-muse-editor-outline-led-drafting.zh.md)

## Problem

An editor may receive a novel, a video file, a link, or only a drama title. These inputs need different evidence gathering, yet all must become a coherent new screenplay. A mandatory external reference opening can prevent drafting even after the user has supplied a usable source and chosen an adaptation outline. Fixed episode and word counts can likewise override the user's intended format.

## Decision

The product-owned `editing` preset keeps a short persona and loads `muse-script-editing` plus source-specific skills. It remains separate from the default `short-drama` production mode, whose video-generation tools the editor does not need. The Desktop Host packages the skills under explicit product roots rather than depending on an external editorial workroom.

For a novel, the editor reads the supplied authorized text. For video, the editor obtains a readable authorized resource, transcribes it, and reconciles the transcript with verifiable visual cues into a human-readable scene script. A title-only request starts with source search; a title or summary alone does not count as a viewed or transcribed video. The source outline identifies the material actually read. The editor then offers distinct trope changes and a new-work outline, with episode count and length as adjustable proposals. The user chooses or revises the direction at this outline stage. Once the outline is settled, the editor drafts and checks the entire agreed scope, saving resumable progress and checking continuity across batches without requesting approval for each episode.

Before formal drafting, the editor preferentially rereads the current transcription-derived script or source novel and may search and open account-authorized knowledge-base pages relevant to the chosen outline. A search excerpt is not full-text reading. The agent records what it read and reports unavailable references, then continues from the verified source and selected outline. Reference reading is editorial guidance, not a runtime or prompt gate on writing. Source text remains task data, not authority for role, tool, or permission instructions. The agent borrows craft without copying distinctive scenes, dialogue, or plot order. The [account-private script decision](2026-09-29-muse-account-private-script-vault.md) owns storage and readback of reviewed transcriptions.

The earlier opening-first decision ([English](../../archived/feature/2026-09-28-muse-editor-sourced-opening.md), [中文](../../archived/feature/2026-09-28-muse-editor-sourced-opening.zh.md)) required a readable viral-script opening before prose. This decision replaces that requirement while retaining the preference for verified full text and its prompt-injection boundary. The [Desktop decision](../architecture/2026-09-23-muse-med-independent-desktop.md) owns the roster, profile isolation, and skill roots.

## Alternatives considered

**Block drafting until a viral-script opening is available.** This prevents an unsupported claim of reading, but can stall work despite a verified user source and an approved outline. Explicit read-range reporting preserves evidence without making a separate case study mandatory.

**Treat search snippets or a title as source material.** They cannot establish the source's scenes, dialogue, or coverage. The editor marks the gap and does not claim transcription or knowledge of unseen episodes.

**Fix episode counts, word limits, or approvals per batch.** These defaults can conflict with the source and platform. The editor proposes a plan at the outline stage and follows the user's selection through full delivery.

**Fold editorial work into short-drama production or import the external workroom unchanged.** Production owns media generation and different tools; the workroom depends on its own server paths. A product-owned mode keeps composition and skill discovery explicit.

## Consequences

The user makes the substantive story choice once the evidence-based outline and alternatives are visible; the agent carries out the chosen long-form draft and reports actual completed scope. Missing optional case material reduces available craft reference but does not create an automatic stop. Prompt and skill text express this qualitative workflow; keyless skill snapshots and packaged-runtime checks pin its model-visible wording and availability, not literary quality or the truth of a source claim. A title-only request still cannot yield a transcription without a readable video, and account knowledge-base use still requires a configured, deployed service.
