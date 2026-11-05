---
description: "Review recorded Muse conversation videos, inspect visual shot ranges and prepare an explicit shot-modification draft."
kind: "package-reference"
---

# @deepseek-ai/dsh-client-ui-session-video

English | [中文](README.zh.md)

## Summary

Review the current conversation's recorded videos in a compact spider control and one expandable player. The timeline shows source-bound visual cut ranges and supports pointer and keyboard seeking. Delivered and supported generated videos retain inline playback and can be collected into the control as the transcript scrolls. Preparing a shot modification appends a reviewable draft; the user still submits it through ordinary chat.

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

The Muse Desktop composition mounts this UI and the [Session video service](../../drama/session-video/README.md). Ordinary Web profiles do not activate either package by default. A custom composition needs both rows plus the native Chat, Deliverables, locale, renderer and Remote services.

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
| `pixelsPerSecond` | `48` | Positive timeline scale; one second occupies this many horizontal pixels |

The Host validates this non-secret presentation policy and includes it in the page bootstrap. A new page reads the resolved value before registering the surface. It is separate from media-processing limits owned by the Session video service.

The shelf reserves one compact header footprint; its expanded curtain floats over the transcript without moving messages or the composer. Opening and closing both ease smoothly, and closing content stays mounted only until its exit transition finishes.

Opening the spider control displays the recorded inventory and analyzes available versioned sources. Missing media, incomplete inventory and failed detection retain explicit status and Retry controls. A failed analysis contributes no invented shot. The combined timeline keeps each source's original local time range; selecting a shot opens its source and seeks to that range.

The video-name selector is a separate capsule on the spider header row and fades with the curtain; it switches sources without repeating the filename over the picture. Timeline zoom adjusts horizontal scale while preserving original media time and shot ranges.

The modification action appends the source, shot identity and original time range to the existing input draft. It neither sends the draft nor replaces a video. Delivered video contributions replace only the playback body; native file preview and opening actions remain with Deliverables.

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

The plugin mounts its generated `sessionVideo` Remote contribution, registers the session-scoped `conversation.chat.pinned` list item and contributes to the native delivery-video chain and closing-Turn surface. Queries use caller cancellation; closing pauses retained playback, and unmounting players releases their media source. The absorption preview preserves the original inline card's layout position and respects reduced-motion preferences. Collection also hides the surrounding native delivery panel; reverse scrolling or teardown restores its original visibility, inert state and ARIA attributes. The spider control, expanded player and inline video card share a dark material with light labels in both page themes.

| Source | Responsibility |
|---|---|
| [config.ts](src/config.ts) | Host-validated public startup scale |
| [client/index.ts](src/client/index.ts) | Remote and native Slot registrations |
| [VideoShelf.tsx](src/client/VideoShelf.tsx) | Inventory, source selection and modification drafts |
| [VideoPlayer.tsx](src/client/VideoPlayer.tsx) | Actual playback, frame capture and media cleanup |
| [VideoTimeline.tsx](src/client/VideoTimeline.tsx) | Controlled time mapping, selection needle and conditional edge fades |
| [useAbsorption.tsx](src/client/useAbsorption.tsx) | Scroll-driven collection preview |

</details>

-----

<a id="further-exploration"></a>
## Further Exploration

- [Session video service](../../drama/session-video/README.md) — recorded-source access and bounded visual detection.
- [Chat](../ui-chat/README.md#message-bubbles) — native transcript and pinned contributions.
- [Deliverables](../ui-deliverables/README.md#explicit-deliveries) — declared files and native actions.

<a id="model-experience"></a>
## Model Experience

### Shot modification draft

#### What the model sees

The UI prepares source identity, shot identity, the source-local time range and editable modification instructions in the ordinary input draft. The English draft labels these fields `Source`, `shot ID` and `original range`. They reach the model only after the user submits that draft. Inventory, playback, scrolling and cut detection add no model input.

#### Token effect

Only the user-submitted draft adds request tokens. Browsing and preparing a draft make no model or generation request.

#### KV Cache effect

Playback and detection preserve the existing request prefix. A later user submission extends ordinary conversation history; the selected provider owns its cache behavior.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

These limits distinguish inspection from media production.

- **Visual cut ranges** — the UI does not infer story scenes, dialogue or character continuity. It references ranges in the original video and creates no separate clip files.
- **Recorded supported sources** — omitted or unavailable sources follow the service's inventory diagnostics. A pasted arbitrary URL does not establish an authorized source.
- **Explicit generation** — modification drafts require user submission and the existing agent workflow; selection alone does not authorize generation or spending.
- **Browser media support** — preview requires a compatible decoder. Frame capture may fail for a remote source without usable cross-origin media access.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

None.

</details>
