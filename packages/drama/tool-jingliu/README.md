---
kind: package-reference
description: "Discover and run Jingliu film production workflows from Muse."
---

# @deepseek-ai/dsh-tool-jingliu

English | [中文](README.zh.md)

## Summary

Use `jingliu_projects` to search and confirm a production for this conversation. `jingliu_studio` reads episodes, imports shared assets and reviews subtitle text and timing. `jingliu_image` defaults to GPT Image 2. Use `jingliu_workflows` and `jingliu_run` for the studio's production operations. Muse writes and locks video prompts before submitting reviewed shots. Jianying exports install editable tracks and their verified media under the chosen local draft directory and return the resulting path in chat.

Requests use the signed-in [Jingliu connection](../jingliu-connection/README.md).

## Table of Contents

- [Running a workflow](#running-a-workflow)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)
- [Dev Note](#dev-note)

## Running a workflow

The plugin reads the catalog at invocation time. Project workflows use the selected conversation project or an explicit project ID when the conversation has no selection. Muse asks for approval before server-declared mutations, generation or costs. A paid workflow's card includes the server quote. If the service requests separate confirmation for an irreversible change, the user sees its reason before Muse submits the same call again. The desktop agent receives an ID derived from the initiating conversation and tool call. Use a returned job ID to look up or wait for the original job.

`jingliu_narration` covers the narration-dialogue production mode. It reads the project state and quality report, sets one of the project's available models, submits dialogue breakdown or production, acknowledges a report item, and exports a Jianying draft. The server quotes each narration job. Muse stores local submission receipts under its private home directory so a replay after an acknowledged submission can reuse the original job ID. If submission was interrupted, reconcile the project job list before another attempt.

## Model Experience

### Finding and running workflows

#### What the model sees

The model uses `jingliu_projects` to confirm a production, `jingliu_studio` to review assets and subtitles, and `jingliu_image` for images. Discovery returns pages of workflow summaries or the complete schema of one named workflow. Execution validates business arguments using that schema and returns the service result with its workflow and project ID. Narration operations use the same project ID and account.

#### Token effect

Only the selected workflow's arguments and results enter the conversation. The catalog is paginated and no complete catalog is added to the system prompt.

#### KV Cache effect

The tool definitions stay stable when the service catalog changes. Discovery results are recorded in the calling conversation.

## Known Limitations and Deferred Work

- A Jingliu service exposing the desktop-agent gateway and a working signed-in account are required. Generation runs and media remain on the project server.
- The narration job route supports active-job deduplication and lacks a durable request key of its own. A lost response can leave a paid outcome unknown.

### Dev Note

<details>
<summary>Maintainer notes</summary>

None.

</details>
