---
description: "Review recorded Muse conversation videos, inspect visual shot ranges and prepare an explicit shot-modification draft."
kind: "package-reference"
---

# @deepseek-ai/dsh-client-ui-session-video

English | [中文](README.zh.md)

## Summary

Review recorded videos directly in chat cards with a source selector, source-bound visual cut ranges and pointer or keyboard seeking. A compact header menu opens historical videos in the same card presentation. Each card retains its own source selection. Preparing a shot modification appends a reviewable draft; the user still submits it through ordinary chat.

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

This package owns the optional chat video cards and Session video history. In **Settings → General → Video cards and timeline**, turn the presentation on or off without restarting or reloading the page. The accepted switch persists in the profile through the native configuration forms. Disabling removes the enhanced players and history action, restores native delivered-video playback, and pauses and releases preview media. Transcript identity, input drafts, attachments, recorded files and running Agent jobs remain owned by Muse. Re-enabling creates a fresh presentation scope without duplicate controls. The settings row remains available while the package is installed.

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

The normal conversation header contains a compact **Conversation videos** menu. Its recorded sources are ordered newest first. Selecting a source opens the same editable video card at the top of the chat in normal document flow, including sources whose original message is not loaded. Close that card to return to the transcript. There is no floating Muse bubble, overlay player or reserved spacer.

A Session controller reads the inventory independently of the menu and cards. Visible cards request analysis of their selected versioned source and share one Session analysis queue. Opening the menu alone does not analyze every video. Missing media, incomplete inventory and failed detection retain status and Retry controls. A failed analysis contributes no invented shot. The combined timeline keeps each source's original local time range; selecting a shot opens its source and seeks to that range.

Each card has its own video selector, selected shot, playback position and timeline scale. Playback and zoom controls retain the original media times and shot ranges. The same card component presents delivered videos, generated videos and selected historical videos.

Pressing the playhead preserves its position. Dragging maps the pointer through the filmstrip's actual on-screen bounds and retains the initial grab offset, including at different page zoom levels.

Each video card exposes a modification control. It is disabled until a timeline shot is selected; its tooltip explains this requirement. Once a shot is selected, the action appends the source, shot identity and original time range to the existing input draft. It neither sends the draft nor replaces a video. Delivered video contributions replace only the playback body; native file preview and opening actions remain with Deliverables.

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

The settings controller owns a serialized child Cordis scope for all optional contributions. It leaves the native conversation header presentation unchanged. The Session video Host service remains separate and available to other consumers; disabling this presentation makes no inventory or analysis requests.

The plugin mounts its generated `sessionVideo` Remote contribution, the Session controller and menu in `conversation.session.header.utilities`, a historical card in `conversation.chat.pinned`, and players in the native delivery-video chain and closing-Turn surface. Queries use caller cancellation. Each visible inline card selects its original source independently and may switch to another source recorded in the same Session. Offscreen cards release their analysis interest, pause playback and stop thumbnail capture; recorded results remain available to the shared timeline. An unmatched delivery retains its native authorized playback URL. Editing detected shots requires a locally version-bound playback source. If the viewer started or sought unbound playback before the source resolved, switching to the bound version requires a gesture and retains the current playback until then. Cards share a dark material with light labels in both page themes.

| Source | Responsibility |
|---|---|
| [config.ts](src/config.ts) | Host-validated public startup scale |
| [client/index.ts](src/client/index.ts) | Remote and native Slot registrations |
| [VideoController.tsx](src/client/VideoController.tsx) | Session inventory and visible-source analysis |
| [VideoHistory.tsx](src/client/VideoHistory.tsx) | Conversation menu and historical video card |
| [VideoPlayer.tsx](src/client/VideoPlayer.tsx) | Actual playback, frame capture and media cleanup |
| [VideoTimeline.tsx](src/client/VideoTimeline.tsx) | Controlled time mapping, selection needle and conditional edge fades |

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
