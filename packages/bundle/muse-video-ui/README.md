---
description: "Install the optional Muse conversation presentation and its recorded-video service together."
kind: "package-bundle"
---

# @deepseek-ai/dsh-muse-video-ui

English | [中文](README.zh.md)

## Summary

An independent optional bundle for Muse conversation bubbles, the spider video curtain, shot timeline and scroll-driven collection animation. It composes the [presentation plugin](../../client/ui-session-video/README.md) and [Session video service](../../drama/session-video/README.md).

## Table of Contents

- [Use this package](#use-this-package)
- [Understand the implementation](#understand-the-implementation)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)
- [Dev Note](#dev-note)

## Use this package

Select this bundle over a Web profile that provides native Chat, Deliverables, configuration forms and the conversation shell. Its patch supplies the canonical `session-video` and `ui-session-video` rows; do not mount duplicate rows. Muse Desktop already ships these contributions and requires no separate installation.

Use **Settings → General → Video bubble and timeline** to switch the entire presentation immediately. The saved preference survives page reloads and application restarts. Disabling restores native navigation and video playback while preserving conversation history, drafts, attachments and background jobs. The setting remains available for re-enabling. Package removal follows the profile's ordinary plugin-management lifecycle; the live switch requires no configuration HMR.

## Understand the implementation

This bundle contains only configuration and localized display metadata. Runtime code, cleanup and configuration fields remain with their owning packages. The presentation owns no generation or Agent execution. The separate media service continues to serve other consumers while the presentation is disabled.

## Model Experience

### Composition

#### What the model sees

Changes to `ui-session-video.enabled` remain presentation settings and never become model input. The bundle itself adds no prompt, tool or model request. A user-submitted shot-modification draft follows the ordinary conversation workflow, as described by the presentation plugin.

#### Token effect

Switching the presentation adds no request tokens. Only a later user submission adds ordinary conversation input.

#### KV Cache effect

Switching the presentation leaves the model request prefix unchanged.

## Known Limitations and Deferred Work

- Requires a Web-capable host and FFmpeg/FFprobe for visual cut detection.
- The switch changes the interface for clients sharing the profile.
- It does not remove recorded media or unload other providers.

### Dev Note

None.
