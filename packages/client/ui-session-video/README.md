---
description: "Select recorded videos by episode, inspect original visual segments in a dockable preview, and request Agent advice or modifications in the same conversation."
kind: "package-reference"
---

# @deepseek-ai/dsh-client-ui-session-video

English | [中文](README.zh.md)

## Summary

Keep a whole drama in one conversation while choosing episodes, videos and original visual segments. Preview the selected video in the right Sidebar or a floating panel without changing the conversation or its draft. Select videos across episodes, request Agent review, then describe changes in ordinary chat. Advice links return to the exact recorded source range; selecting media does not modify or regenerate it.

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

The independent [Muse video bundle](../../bundle/muse-video-ui/README.md) installs this presentation and its media service together.

This package owns the optional Muse video workspace. In **Settings → General → Muse video workspace**, turn it on or off without restarting or reloading the page. The accepted switch persists in the profile through the native configuration forms. Disabling releases this presentation's registrations and preview media while preserving the conversation, draft, attachments, recorded files and running Agent tasks. Re-enabling creates a fresh presentation scope without duplicate controls. The settings row remains available while the package is installed.

The Muse Desktop composition mounts this UI and the [Session video service](../../drama/session-video/README.md). Ordinary Web profiles do not activate either package by default. A custom composition retains the canonical `ui-session-video` entry id for its live settings and needs both rows plus the native Chat, Deliverables, locale, renderer and Remote services.

```yaml
- insert:
    - id: session-video
      name: '@deepseek-ai/dsh-session-video'
    - id: ui-session-video
      name: '@deepseek-ai/dsh-client-ui-session-video'
      config:
        pixelsPerSecond: 48
```

| Field | Default | Meaning |
|---|---|---|
| `enabled` | `true` | Live switch for the complete conversation presentation; also available in General settings |
| `pixelsPerSecond` | `48` | Positive timeline scale; one second occupies this many horizontal pixels |

The Host validates this non-secret presentation policy and includes it in the page bootstrap. A new page reads the resolved value before registering the surface; accepted live settings replace the startup switch. The `enabled` field is volatile and changes only presentation registrations, even when configuration HMR is disabled. It is separate from media-processing limits owned by the Session video service.

The conversation entry and recorded-video cards open the same video workspace. The native right Sidebar owns docking, floating, resizing and tab navigation; these operations keep the same conversation, playback selection and composer. The video workspace does not create a new Session for an episode.

The preview uses the panel height remaining after navigation and controls. Portrait and landscape media fit the available width and height without cropping or stretching. Resizing or floating the panel preserves playback. Short panels scroll internally while retaining a usable preview and access to the controls.

The video picker filters the recorded inventory by display episode number. Only structured production facts establish episode membership; sources without a verified display number remain **Unassigned**. Changing the filter does not clear cross-episode selections. Missing media, incomplete inventory and failed detection retain explicit status and Retry controls. A failed analysis contributes no invented visual segment.

**Add to chat** adds the current video or selected timeline segment to the same composer. **Whole video** clears the preview's segment scope without changing playback time or existing composer references. The picker also supports whole-video selection across episodes. Each choice retains the source identity, version and original time range. FFmpeg-detected visual segments are independent of authored production shot numbers and video-package indexes. Timeline zoom adjusts horizontal scale while preserving original media time and segment ranges.

Pressing the playhead preserves its position. Dragging maps the pointer through the filmstrip's actual on-screen bounds and retains the initial grab offset, including at different page zoom levels.

**Review selected videos** uses existing selected references; when none exist, it adds the current video or selected segment directly. It requests a bounded, read-only review with at most three issues and actionable suggestions, each linking to the supplied source location. An empty composer without attachments can submit directly; existing unfinished input is retained. Structured references identify `muse_video` as the review tool. The Host enforces its selected interval; the prompt alone grants no editing or generation permission.

Authored shot buttons use observed, version-bound `shotRanges` independently of detected cuts. Shots without observed timing remain disabled with an explanation. Selecting an authored shot seeks to its real interval and includes that shot number in the ordinary conversation reference.

Selected-video references can accompany a natural-language modification request in the same composer. Reference serialization checks the latest inventory before submitting source evidence; a changed or unavailable source refuses submission and keeps the draft for reselection. **Prepare edit** adds an editable modification request without sending it. Modification and regeneration requests instruct the Agent to retain the original version and unaffected content. Media selection alone authorizes neither operation.

Agent advice links reopen the same workspace at the recorded source version and original range. Stale links report that the selection must be refreshed rather than silently targeting a different version. Delivered-video contributions show compact entries that open the right-hand preview; native file preview and opening actions remain with Deliverables.

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

The settings controller owns a serialized child Cordis scope for optional contributions. The native Session-header video utility opens the workspace independently of the coordinator. The Session video Host service remains separate and available to other consumers. Disabling the workspace stops its inventory observation and visual analysis; its input-reference codec stays registered so existing video references can still be sent through ordinary chat, reading the current inventory only when the user submits them.

The plugin mounts the generated `sessionVideo` Remote contribution and registers a native right-Sidebar tab. The resource provider retains the owning Session, refreshes its inventory from recorded changes, and cancels released reads. A Session-scoped view store retains browsing and source-local selections across presentation changes. Composer references use the existing input-trigger codec and ordinary message submission; the plugin owns no second message pipeline. Unmounting players releases media, and optional thumbnail failure leaves playback available.

Selection evidence uses the owned `<muse-video-selection>` text envelope. While the workspace is enabled, its user-text rule accepts only the plugin's strict field set and self-consistent source links, then renders compact video labels in sent messages and queue previews. Arbitrary JSON, malformed envelopes and unsupported fields remain plain text. Only interactive labels in the owning conversation can navigate; rendering does not rewrite the logged or model-visible message.

| Source | Responsibility |
|---|---|
| [config.ts](src/config.ts) | Host-validated public startup scale |
| [client/index.ts](src/client/index.ts) | Remote and native Slot registrations |
| [VideoWorkspace.tsx](src/client/VideoWorkspace.tsx) | Episode filtering, multi-selection, preview and review requests |
| [VideoPlayer.tsx](src/client/VideoPlayer.tsx) | Actual playback, frame capture and media cleanup |
| [VideoTimeline.tsx](src/client/VideoTimeline.tsx) | Controlled time mapping, selection needle and conditional edge fades |
| [target-selection.ts](src/client/target-selection.ts) | Version-bound selections, source evidence and advice-link coordinates |
| [references.ts](src/client/references.ts) | Composer references and submission-time source validation |
| [user-text-rules.ts](src/client/user-text-rules.ts) | Strict owned-envelope matching and compact user-text nodes |
| [VideoSelectionText.tsx](src/client/VideoSelectionText.tsx) | Native inline video labels and same-conversation navigation |

</details>

-----

<a id="further-exploration"></a>
## Further Exploration

- [Session video service](../../drama/session-video/README.md) — recorded-source access and bounded visual detection.
- [Chat](../ui-chat/README.md#message-bubbles) — native transcript and pinned contributions.
- [Deliverables](../ui-deliverables/README.md#explicit-deliveries) — declared files and native actions.

<a id="model-experience"></a>
## Model Experience

### Video review and modification

#### What the model sees

The submitted user message contains the review or modification request and delimited structured source evidence, including source identity and version, local path or recorded provider URL, event coordinates, optional production metadata and authored shot number, original segment range, review tool and `review_link`. References remain editable in the normal composer, and the model receives the complete recorded evidence. Inventory, playback, episode filtering and visual-cut detection add no model input.

#### Token effect

Only a submitted review or modification message adds request tokens. Read-only Agent review can consume model tokens. Browsing, selecting media and preparing an unsent draft make no model or generation request.

#### KV Cache effect

Playback and detection preserve the existing request prefix. A later user submission extends ordinary conversation history; the selected provider owns its cache behavior.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

These limits distinguish inspection from media production.

- **Visual cut ranges** — detection does not infer story scenes, dialogue, character continuity or authored shot numbers. It references original-video ranges and creates no separate clip files; the requested Agent review owns content observations and their uncertainty.
- **Recorded supported sources** — omitted or unavailable sources follow the service's inventory diagnostics. A pasted arbitrary URL does not establish an authorized source.
- **Explicit generation** — selecting media and requesting advice do not authorize generation or spending. Modification and regeneration proceed only through the submitted user request and existing Agent tools.
- **Browser media support** — preview requires a compatible decoder. Frame capture may fail for a remote source without usable cross-origin media access.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

None.

</details>
