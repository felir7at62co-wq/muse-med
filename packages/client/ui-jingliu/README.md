---
description: "Jingliu's original ShotFlow workspace in the Muse right sidebar."
kind: "package-reference"
---

# @deepseek-ai/dsh-client-ui-jingliu

English | [中文](README.zh.md)

## Summary

Set `studioOrigin` to a dedicated HTTPS origin, or an HTTP loopback origin for a local studio. Open **Jingliu** below Files, Terminal and Browser in the right sidebar. The tab loads the original `/sfp/` page. Its projects, media, selection, authentication and job state belong to that studio. Omitting the origin removes the entry.

The studio scales to fit the sidebar while retaining its desktop layout. Narrow panes scroll horizontally. Use the sidebar's fullscreen control for more working space.

## Table of Contents

- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)
- [Dev Note](#dev-note)

## Model Experience

### Opening the studio

#### What the model sees

Opening `/sfp/` contributes no prompt, tool or Session event. Jingliu workflow tools use their own Host account.

#### Token effect

Opening a panel does not use model tokens.

#### KV Cache effect

Viewing the studio leaves the model prefix unchanged.

## Known Limitations and Deferred Work

- An embedded deployment must permit its studio page to be framed by Muse. Feishu sign-in opens the external authorization page and the studio polls for the result.
- The studio keeps its own web session on its origin. A project selected in the studio does not select the target of a tool call.

### Dev Note

<details>
<summary>Maintainer notes</summary>

None.

</details>
