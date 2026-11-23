---
description: "The original script workshop and Jingliu production studio in the Muse right sidebar."
kind: "package-reference"
---

# @deepseek-ai/dsh-client-ui-jingliu

English | [中文](README.zh.md)

## Summary

With `studioOrigin` mounted at `/jingliu/` on the Muse account gateway, production projects, shared assets, balance and project settings appear in Muse. Choose **Workspace** from the right sidebar's **+** menu to see the current folder or add a workspace through the folder picker. A dedicated studio origin uses the original studio tab. The script workshop opens its writing workspace in a separate tab.

**Shared assets → Characters** shows the studio’s original reference images and descriptions.

The Bot team's panel has its own **Scripts**, **Jingliu**, **Asset library** and **数据** tabs; see [Use this package](#use-this-package).

Embedded tabs retain the document. Changing accounts opens a fresh sign-in frame.

## Table of Contents

- [Use this package](#use-this-package)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)
- [Dev Note](#dev-note)

## Use this package

In the Bot team's panel, for a Bot's chat and for a group chat alike, the **Jingliu** tab lists production projects, newest first with their settings as tags; **New project** and the search card sit above the list. A project picked from the list or the search card opens in a panel tab of its own, so several can be open side by side. Opening one to look at it leaves the conversation's project as it is: a conversation with none takes the first one opened, and a request made from another project's tab makes that project the conversation's before it reaches the message box. Each project tab is a workbench that shows the project's assets (characters, locations, blocking diagrams, props, audio, posters) and, for each episode, every shot as a card: its prompt with the assets it names, its video and versions, its generation settings and materials. A video loads through the Host only when played. The new-project form creates a production from the choices the studio offers; **Project settings** changes only the name and the resolution, the two settings the studio lets a client change. Deleting a shot asks once in place and is carried out by the studio at once. **Quote**, **Make another**, **Copy**, choosing an asset, **Batch export** and **Make posters** put a reference or a prepared request into that conversation's message box; Muse carries them out once the user sends them. The **Asset library** tab lists the shared assets by kind, most used first; picking or dragging one hands it to the message box. Posters, videos, effects, audio, sound effects and BGM have no shared library yet and list nothing.

The **数据** (Data) tab lists the data station's platforms — 红果, 抖音, 绿泡泡, 番茄 and 七猫 — with each one's ranking count or collector state. Picking one opens it in a panel tab of its own, like a Jingliu project, on its 全收录 view: every work the station collected on that platform, newest first, with a search box over title, author, ID, description and tags. Next to it are its rankings by level (for example 男频 · 阅读榜 · category) for a day, week or month, with the platform's own two metrics and a button that quotes a work into the conversation. 红果 adds 转写 on each ranking row and a 储备 page with the transcription stock's filters, search, episode progress and 立即转写. Reads and 立即转写 go through the `museAccount` data-station methods as the signed-in member, so the station records that member as the requester.

The **Scripts** tab, before **Jingliu**, opens **Drafts** for the signed-in Workshop account. Create a blank draft with numbered episodes, import a Word, TXT or Markdown file up to 4 MB, or find a saved draft by title. Choose an episode and quote it into chat. Muse can submit changes for one episode. Use **Refresh** to fetch the latest proposal while the draft stays open. The editor shows the difference against the saved episode and lets the user apply or discard the proposal. Users can edit and save an episode directly. If the cloud version changed, refresh and review it before saving. Switch between the manuscript and its scene script to review or edit either layer. **Episode history** previews a saved version and restores it as a new revision of the current layer. **Export script** downloads one episode or the whole draft in Word, TXT or Markdown. The manuscript and scene script support single-episode export. Mixed content and the outline export the whole draft. **Finalize script** asks for rights, form and production style before saving a version to the finalized library.

Every member can read **Finalized scripts**. Search by title and filter by stage or ownership. A script opens in its own panel tab with its version, rights, source work and episode text. A member with pick permission chooses the displayed version, then links an existing Jingliu project or puts a **New Jingliu project** request in the message box. The source-work card displays the data-station record.

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
- Selecting a draft or switching episodes does not change the chat target. Use **Quote in the message box** to include the draft ID and the selected episode in a message.

### Dev Note

<details>
<summary>Maintainer notes</summary>

None.

</details>
