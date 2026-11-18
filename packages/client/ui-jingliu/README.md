---
description: "The original script workshop and Jingliu production studio in the Muse right sidebar."
kind: "package-reference"
---

# @deepseek-ai/dsh-client-ui-jingliu

English | [中文](README.zh.md)

## Summary

Set `workshopOrigin` to the script workshop deployment and `studioOrigin` to the Jingliu deployment. Each accepts an HTTPS origin or an HTTP loopback IP origin. Each appears below Files, Terminal and Browser in the right sidebar. **Script workshop** opens the writing homepage at `/v2` to create, edit and review drafts. **Jingliu** opens its production workspace at `/sfp/`.

The panels start at `/v1/auth/muse/embed` and `/fwp/v2/auth/muse/embed` respectively. Switching tabs preserves the document. Switching Muse accounts or reconnecting the Host opens a fresh sign-in frame. Narrow panes scroll horizontally at minimum zoom. Use the sidebar's fullscreen control for more writing or production space.

## Table of Contents

- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)
- [Dev Note](#dev-note)

## Model Experience

### Opening the studio

#### What the model sees

Opening the writing page at `/v2` or the production page at `/sfp/` contributes no prompt, tool or Session event. Jingliu workflow tools authenticate through the current Desktop Muse account.

#### Token effect

Opening a panel does not use model tokens.

#### KV Cache effect

Viewing the studio leaves the model prefix unchanged.

## Known Limitations and Deferred Work

- Each deployment must allow Muse to embed its page. The [workbench login adapters](../../../services/muse-workbenches/README.md) connect both sign-in pages to the Muse account gateway.
- Each application manages its own account session, drafts and projects. Selecting a page or switching tabs does not transfer a draft to Jingliu or select a target for chat tools.

### Dev Note

<details>
<summary>Maintainer notes</summary>

None.

</details>
