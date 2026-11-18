---
description: "The original script workshop and Jingliu production studio in the Muse right sidebar."
kind: "package-reference"
---

# @deepseek-ai/dsh-client-ui-jingliu

English | [中文](README.zh.md)

## Summary

With `studioOrigin` mounted at `/jingliu/` on the Muse account gateway, production projects, shared assets, balance and project settings appear in Muse. In the right sidebar, **Environment** shows the local workspace and the cloud project confirmed for this conversation. **Add workspace** opens the platform's folder picker or links a production project. A dedicated studio origin uses the original studio tab. The script workshop opens its writing workspace in a separate tab.

Embedded tabs retain the document. Changing accounts opens a fresh sign-in frame.

## Table of Contents

- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)
- [Dev Note](#dev-note)

## Model Experience

### Opening the studio

#### What the model sees

Opening the writing page at `/v2` or the production page at `/sfp/` contributes no prompt, tool or Session event. Confirming a production adds its title and ID to the current conversation as a Host notice.

#### Token effect

Opening a panel does not use model tokens.

#### KV Cache effect

Viewing the studio leaves the model prefix unchanged.

## Known Limitations and Deferred Work

- Embedded deployments must allow Muse to display their pages. The [workbench login adapters](../../../services/muse-workbenches/README.md) connect both sign-in pages to the Muse account gateway.
- Each application manages its own account session, drafts and projects. Selecting a page or switching tabs does not transfer a draft to Jingliu or select a target for chat tools.

### Dev Note

<details>
<summary>Maintainer notes</summary>

None.

</details>
