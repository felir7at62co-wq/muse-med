---
kind: package-reference
description: "Discover and run Jingliu film production workflows from Muse."
---

# @deepseek-ai/dsh-tool-jingliu

English | [中文](README.zh.md)

## Summary

Use `jingliu_projects` to find and confirm a production. `jingliu_studio` reads episodes, imports assets, lists subtitles and edits subtitle text. `episode_subtitles` sets subtitle timing. `jingliu_image` defaults to GPT Image 2. Find and run workflows with `jingliu_workflows` and `jingliu_run`. Muse writes and locks reviewed video prompts before submission. Jianying exports place editable tracks and verified media in the local draft directory and return its path.

Requests use the signed-in [Jingliu connection](../jingliu-connection/README.md).

`muse_billing` reads the current user's Jingliu balance and can include their ten latest ledger entries. The entries report signed changes in credit, including holds and settlement adjustments.

## Table of Contents

- [Running a workflow](#running-a-workflow)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)
- [Dev Note](#dev-note)

## Running a workflow

The plugin reads the catalog at invocation time. Project workflows use the selected conversation project or an explicit project ID when the conversation has no selection. Muse asks for approval before server-declared mutations, generation or costs. A paid workflow's card includes the server quote. If the service requests separate confirmation for an irreversible change, the user sees its reason before Muse submits the same call again. The desktop agent receives an ID derived from the initiating conversation and tool call. Use a returned job ID to look up or wait for the original job.

`jingliu_media` moves files between the conversation's workspace and the studio. `download` places stored `/fw/media/...` addresses at `<workspace>/jingliu/<project>/<dir>/<name>`, each downloaded once, so local tools such as `jianying_draft` can use them; only the desktop Host keeps local files, and elsewhere the action fails with `JINGLIU_MEDIA_LOCAL_DISABLED`. `upload` sends one local image, audio or video file after the user approves it and returns its `/fw/media/uploads/...` address for workflow arguments that take uploaded media. A Jianying export downloads its materials into the same project folder and links or copies them into the draft, so every episode of a production reuses shots already downloaded. A Host without local media, such as the Web Host, installs no draft and returns the studio's export result.

`jingliu_narration` covers the narration-dialogue production mode. It reads the project state and quality report, sets one of the project's available models, submits dialogue breakdown or production, acknowledges a report item, and exports a Jianying draft. The server quotes each narration job. Muse stores local submission receipts under its private home directory so a replay after an acknowledged submission can reuse the original job ID. If submission was interrupted, reconcile the project job list before another attempt.

Other Host tools use `@deepseek-ai/dsh-tool-jingliu/library`. `plannedDrafts` installs batch Jianying drafts from `POST /projects/{pid}/jianying/plan`, at most ten episodes per request: it refuses an episode whose stored subtitles are stale, missing or unverified and names the shot orders, and accepts unverified ones when the caller sets `keepLegacy` for a user who chose to keep legacy rows, downloads each material once into `<workspace>/jingliu/<project>`, links it into each draft, cuts the cover with the caller's FFmpeg and installs the draft by rename. A draft's fingerprint is the account, project, episode and the plan's `draft_sha256`, so a repeated call returns the installed draft and a changed plan installs a new one beside it; a server without the route makes every episode `jingliu_outdated`. `submitOnce` is the once-only job submission the narration and image tools use. `jingliu_run export_jianying` keeps installing the studio's zip package.

Draft installation retries transient Windows rename errors for a bounded interval. Cancellation before publication or a failed installation removes the staging directory.

## Model Experience

### Finding and running workflows

#### What the model sees

The model uses `jingliu_projects` to confirm a production, `jingliu_studio` to review assets and subtitles, `jingliu_image` for images, and `jingliu_media` to download or upload files. Discovery returns pages of workflow summaries or the complete schema of one named workflow. Execution validates business arguments using that schema and returns the service result with its workflow and project ID. Narration operations use the same project ID and account.

#### Token effect

Only the selected workflow's arguments and results enter the conversation. The catalog is paginated and no complete catalog is added to the system prompt. `jingliu_media` adds one tool definition; its results list only stored addresses, local paths, sizes and media types.

#### KV Cache effect

The tool definitions stay stable when the service catalog changes. Discovery results are recorded in the calling conversation.

## Known Limitations and Deferred Work

- A Jingliu service exposing the desktop-agent gateway and a working signed-in account are required. Generation runs on the project server; media lives in its object storage and is downloaded to this computer when a tool or view needs it.
- The narration job route supports active-job deduplication and lacks a durable request key of its own. A lost response can leave a paid outcome unknown.

### Dev Note

<details>
<summary>Maintainer notes</summary>

None.

</details>
