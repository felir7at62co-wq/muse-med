---
description: "The original script workshop and Jingliu production studio in the Muse right sidebar."
kind: "package-reference"
---

# @deepseek-ai/dsh-client-ui-jingliu

English | [中文](README.zh.md)

## Summary

Set `workshopOrigin` to the script workshop deployment and `studioOrigin` to the Jingliu deployment. Each accepts an HTTPS origin or an HTTP loopback IP origin. Each appears below Files, Terminal and Browser in the right sidebar. **Script workshop** opens the writing homepage at `/v2` to create, edit and review drafts. **Jingliu** opens its production workspace at `/sfp/`.

Set `editorOrigin` to the numeric HTTP loopback address and port of [OpenChatCut](https://github.com/0xsline/OpenChatCut). **Video editor** opens its original timeline, mixer and export controls. When Jingliu is also connected, **Import from Jingliu** copies the selected episode’s available shots into a new local editing project.

Set `editorTokenFile` to the local editor’s MCP token file to edit an open project from the main Muse chat. The development launcher resolves the file for the current OpenChatCut profile. The timeline and player preview each draft edit in the sidebar. Apply or reject the proposed changes there. A project stays connected to its conversation when the sidebar is collapsed. If several projects are open in one conversation, Muse can look them up by name. Media inspection, rendering and encoding run on the desktop, including transparent clips. Opening OpenChatCut separately uses its standalone Agent.

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
- Jingliu and the script workshop manage their own projects. OpenChatCut tools need an open project in the same Muse conversation. Transcription and media generation use the services configured for the tool that performs the operation.

### Dev Note

<details>
<summary>Maintainer notes</summary>

None.

</details>
