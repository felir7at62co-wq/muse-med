---
description: "The original script workshop and Jingliu production studio in the Muse right sidebar."
kind: "package-reference"
---

# @deepseek-ai/dsh-client-ui-jingliu

English | [中文](README.zh.md)

## Summary

With `studioOrigin` mounted at `/jingliu/` on the Muse account gateway, production projects, shared assets, balance and project settings appear in Muse. In the right sidebar, **Environment** shows the local workspace, and **Add workspace** opens the platform's folder picker. A dedicated studio origin uses the original studio tab. The script workshop opens its writing workspace in a separate tab.

**Shared assets → Characters** shows the studio’s original reference images and descriptions.

In the Bot team's panel, the **Jingliu** tab lists production projects, newest first with their settings as tags; **New project** and the search card sit above the list. A project picked from the list or the search card opens in a panel tab of its own, so several can be open side by side. Opening one to look at it leaves the conversation's project as it is: a conversation with none takes the first one opened, and a request made from another project's tab makes that project the conversation's before it reaches the message box. Each project tab is a workbench that shows the project's assets (characters, locations, props, audio, posters) and, for each episode, every shot as a card: its prompt with the assets it names, its video and versions, its generation settings and materials. A video loads through the Host only when played. The new-project form creates a production from the choices the studio offers; **Project settings** changes only the name and the resolution, the two settings the studio lets a client change. Deleting a shot asks once in place and is carried out by the studio at once. **Quote**, **Make another**, **Copy**, choosing an asset, **Batch export** and **Make posters** put a reference or a prepared request into that conversation's message box; Muse carries them out once the user sends them. The **Asset library** tab lists the shared assets by kind, most used first; picking or dragging one hands it to the message box. Posters, videos, effects, audio, sound effects and BGM have no shared library yet and list nothing.

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
