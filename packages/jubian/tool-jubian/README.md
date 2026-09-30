---
description: "Twelve Jubian (剧变) tools for screenplay pool inspection and authorized claims, production catalogues, assets, storyboards, paid generation, media download and background jobs."
kind: "package-bundle"
---

# @deepseek-ai/dsh-tool-jubian

English | [中文](README.zh.md)

## Summary

`dsh-tool-jubian` gives a DSH model twelve tools for the screenplay pool and Jubian production: catalogue reads, screenplay lookup, authorized pool claims, asset and storyboard edits, a read-only organization index, reference upload, paid image and video generation, subtitle erasure, upscaling, media download and background jobs. Reads are free; paid or state-changing calls use caller-supplied idempotency keys, and the plugin records an intent before each request and a settlement after its response. A replayed key never repeats a write; reconciliation methods may perform fresh reads.

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

Mount the row in any preset that needs to read or change a Jubian production, then give the model a task; the twelve tools state their effects in their descriptions.

### When to choose it

Choose this package when an agent must inspect or claim a screenplay from the account pool, resolve a screenplay name, organize assets, upload a reference image, save a subject selection, prepare and submit video, confirm casting, generate images, erase subtitles, upscale a clip, or download provider media. Mount it wherever the credential resolves. When the session does not use Jubian, omit the row because its twelve schemas remain model-visible while mounted.

### Minimal configuration

```yaml
- insert:
    - id: tool-jubian
      name: '@deepseek-ai/dsh-tool-jubian'
      # config is optional:
      # ledgerRoot: D:\somewhere\jubian-ledger   # default <DSH_HOME>/jubian/ledger
      # baseUrl: https://web.jubianai.net/prod-api
      # timeoutMs: 30000
      # workspaceSecrets: true                   # default true
      # imagePlatformId: KU_AI                   # which gpt-image-2 platform the paid image route buys from
      # imageStandardId: 66                      # or the catalogue row's own id, instead of the platform
      # imageActiveTimeoutMs: 180000             # default 180000
      # imageActivePollMs: 3000                  # default 3000
      # imageBatchConcurrency: 3                 # concurrent image requests, 1..8
      # imageBatchMaxItems: 12                   # batch size limit, 1..100
      # videoBatchConcurrency: 3                 # concurrent storyboard submissions, 1..8
      # videoBatchMaxItems: 100                  # video batch size limit, 1..100
      # nameSeparator: '｜'                      # default '｜'
      # seriesLabel: 全剧                        # default 全剧
      # assetIndexPath: _probe/asset-index.md    # default _probe/asset-index.md
```

| Field | Default | Meaning |
|---|---|---|
| `ledgerRoot` | `<DSH_HOME>/jubian/ledger` | Directory holding the write ledger; one NDJSON file per day |
| `baseUrl` | the transport's own default origin | Origin override for every request |
| `timeoutMs` | the transport's own default | Per-call abort budget in milliseconds |
| `watchPollIntervalMs` | `15000` | Watch polling interval in milliseconds; integer within 1..60000 |
| `watchTimeoutMs` | `1800000` | Watch deadline in milliseconds; integer within 1..86400000 |
| `claimPollIntervalMs` | `5000` | Pool claim polling interval in milliseconds; integer 1000..60000 |
| `claimMaxWindowMs` | `7200000` | Maximum authorized claim window in milliseconds |
| `claimMaxLeadMs` | `86400000` | Maximum lead time before a claim window starts, in milliseconds |
| `claimScanPageSize` | `300` | Rows per account pool scan request; integer 1..1000 |
| `claimScanPageLimit` | `50` | Pages per complete account pool scan; integer 1..100 |
| `claimMaxItems` | `100` | Maximum distinct screenplay IDs one job may attempt; integer 1..100 |
| `workspaceSecrets` | `true` | Whether the workspace pipeline secret file may stand in for a missing credential-store value |
| `imagePlatformId` | none | Which `platformId` of the `taskType=2` catalogue `image_generate` buys from, such as `KU_AI`; the fallback pin, used only while the short-drama settings section pins no row |
| `imageStandardId` | none | Which catalogue row (`standardId`, the row's own `id`) `image_generate` buys from; either this or `imagePlatformId` pins one row, under the same settings-page precedence |
| `imageActiveTimeoutMs` | `180000` | How long `image_generate` waits for the new asset to reach `hsAssetStatus` `Active` before reporting a timeout |
| `imageActivePollMs` | `3000` | Delay between the readback polls above |
| `imageBatchConcurrency` | `3` | Maximum simultaneous image requests in one batch; integer 1..8 |
| `imageBatchMaxItems` | `12` | Maximum requests in one image batch; integer 1..100 |
| `videoBatchConcurrency` | `3` | Maximum simultaneous storyboard PUTs after batch preflight; integer 1..8 |
| `videoBatchMaxItems` | `100` | Maximum distinct storyboard previews in one batch; integer 1..100 |
| `nameSeparator` | `｜` | Separator between the segments of a name this row composes from an `episode` argument |
| `seriesLabel` | `全剧` | Episode token of an asset that serves the whole series; a caller passes exactly this value as `episode` |
| `assetIndexPath` | `_probe/asset-index.md` | Where `jubian_organize` writes its index, relative to the project directory |

A blank `nameSeparator` or `seriesLabel` fails the mount: a name composed with either could not be split back into its segments.

An account catalogue can list one model id once per platform at different prices; `image_generate` never picks one of those rows for you, so a catalogue with several `gpt-image-2` rows and no pinned row fails while the request body is compiled and lists every candidate with its `platformId`, `standardId`, unit price and unit.

A row is pinned in one of two places, and the settings page wins: **Settings → 短剧 → 资产图生成通道** stores the choice in the `drama` settings section and lists the live candidates with their prices, while these two config fields remain what a deployment without that page states. The pin is resolved as each paid call is made, so a page edit reaches the next call without a restart, and a page-pinned row is the whole selection — a config platform beside it is dropped rather than merged into a pin the person did not choose.

`jubian_video image_generate` may set `image_platform_id` for one call; it selects that platform's live catalogue row ahead of the saved or deployment pin. Muse's bundled deployment pins `KU_AI` when the user has not chosen a row. An authorized fallback can request `DUO_YUAN_TAN_SUO` explicitly. Check its live price and the previous paid task before switching: a timeout or unknown result is not a failed charge and must be reconciled before a new key or route is used.

The generated [configuration catalog](../../../docs/config-catalog.md#deepseek-aidsh-tool-jubian) is the exhaustive source for every accepted field and its JSDoc. The row injects `tools` and `credentials`, registers all twelve tools at mount, and mounts three Remote namespaces: `jubianToken` for account credentials, `jubianImage` for the account's `gpt-image-2` rows, and `jubianBudget` for the Settings page's live project ceiling and accounting. There is no per-tool enable flag and no separate page row.

### Credential

The row resolves the provider token through `ctx.credentials` on every call, so a value changed in the credential store is picked up by the next call without a restart.

| Item | Location |
|---|---|
| Reference name | `JUBIANAI_ADMIN_TOKEN`, declared by the transport package |
| Value store | `$DSH_HOME/.credentials.yaml`, read through the DSH `credentials` service |
| Environment override | `JUBIANAI_ADMIN_TOKEN` |

The credential provider resolves in this order, highest first, from [`credentials-local`](../../credentials/credentials-local/src/index.ts):

```text
inherited process environment (read-only, highest)
> $DSH_HOME/.credentials.yaml (provider-managed, writable)
> <launch directory>/.env
> $DSH_HOME/.env
```

The inherited process environment wins, so `JUBIANAI_ADMIN_TOKEN=… dsh` overrides the stored value and makes it read-only. When a changed token appears to have no effect, check that order first. The transport repairs the boundary damage a paste usually carries — leading or trailing whitespace, one `;`, one pair of quotes — and never rewrites the token itself; a value with interior whitespace fails locally and sends no request. Plaintext never enters a tool result.

When the credential store resolves to nothing, the row falls back — only then — to the pipeline's own secret file, `.agents/secrets/pipeline.env`, searched upward from the launch directory. `JUBIANAI_ADMIN_TOKEN` wins over the legacy `JUBIANAI_TOKEN` inside it. The file is read on every call, so an edit is picked up without a restart, and the value is never echoed. Set `workspaceSecrets: false` to make the credential store the only source.

### The token Settings page

The same credential has a page under **Settings → Jubian**. That page belongs to this package rather than to a generic configuration surface: the generic surface writes any reference a page names, while this one writes only `JUBIANAI_ADMIN_TOKEN`.

It reports whether a value is configured, which source supplies it, and whether this deployment can write it. A read-only source — the inherited process environment, for example — disables both buttons and says so. Save stores the pasted value through the Host credential service, Clear removes it, and neither answers with the value: the field is empty after a successful write, and the status line is the only evidence that a token is stored.

Both directions cross the browser/Host boundary through the generated `jubianToken` Remote namespace (`describe`, `set`, `unset`). `set` refuses an empty or whitespace-only value and names `unset` as the way to clear the reference, and a provider refusal is reported as `jubian-token/rejected` whose details carry only the reference.

### The image-route Remote namespace

The second namespace, `jubianImage`, exists for one read: `routes()` returns the account's `gpt-image-2` catalogue rows — `standardId`, `platformId`, unit price and unit — so **Settings → 短剧** can offer them by price instead of making somebody read a failure message. It is free, it is the same catalogue read the paid call makes over the same transport, and no method here writes anything or returns the token.

A catalogue it cannot read is reported as `jubian-image/catalogue-unreadable` carrying the transport's own message, and the page shows that message verbatim. Nothing is cached: every call reads the account, because a row's price and existence are account state rather than plugin state.

### The twelve tools

`jubian_budget` and the `jubianBudget` Settings namespace share `<ledger>/authorization.json` and the paid-call accounting reader. Projects without a separate authorization inherit the live drama default, initially ¥4000; a separately authorized amount replaces that default. Chat updates require actual user budget text for the exact project or the Session's bound project, or a genuine answer to an `ask_user_question` explicitly naming that project's total budget. Assistant statements, unrelated answers, withdrawn approval and mismatched amounts cannot authorize an update. A read supplies the exact revision; updates preserve spend, reservations and estimates, and return actual saved data immediately without restarting. The [project bible skill](../../drama/skills/skills/tweet-drama-project-bible/SKILL.md) describes the missing-authorization question. The Settings writer treats the user's project-ceiling submission as authorization; this local workflow does not isolate files from a user with direct filesystem access.

The twelve registered tools are the whole model-facing surface. This package publishes no system-prompt section, so every operational fact the model needs travels in a tool description or a schema description.

| Tool | Methods | Billing and effect |
|---|---|---|
| `jubian_budget` | `read`, `update` | Free; reads actual accounting or saves a verified user-approved project ceiling |
| `jubian_catalog` | `models`, `rate`, `script`, `episodes` | Read-only, no charge |
| `jubian_find` | `scope` (`mine`, `pool`), `mine` filters `production_type` / `share_target_type` | Read-only, no charge |
| `jubian_claim` | `inspect`, `claim` | Inspect is read-only; claim requires explicit user authorization, `canClaim=1`, and an idempotency key |
| `jubian_snatch` | `ids`, `new_claimable` | Bounded background claim job within an explicitly authorized UTC window |
| `jubian_asset` | `get`, `list`, `materials`, `generated_image` | Read-only, no charge |
| | `confirm_casting` | Changes provider state through a `GET`; needs `idempotency_key` |
| | `remove` | Deletes an inspected image parent irrecoverably; audio requires dedicated deletion methods |
| | `upload_reference` | Free and task-free; writes one object into the provider's bucket |
| | `upload_audio` | Free and task-free; measures a local PCM WAV reference of at most 15 seconds, then uploads one object |
| | `register`, `audio_list`, `audio_get` | Registers uploaded media with an explicit category; audio category is 4, with project-scoped reads |
| | `audio_delete_preview`, `audio_delete_apply` | Inspects authorized audio and references, then deletes once with verified readback |
| | `create_folder`, `move`, `rename` | Reorganize the console's asset library; each needs `idempotency_key` |
| `jubian_organize` | `index` | Read-only and free; writes one local index file |
| `jubian_model` | `preview`, `apply` | Preview is read-only remotely; apply saves approved existing storyboard settings with `isGenerate=0` |
| `jubian_storyboard` | `list`, `get`, `create`, `save` | List/get are read-only; create/save are free writes that force `isGenerate=0`, including caller-supplied create bodies |
| | `edit_preview`, `edit_batch_preview`, `edit_apply` | Inspect and save existing cards in place, retaining IDs; no generation |
| | `audio_preview`, `audio_apply` | Replaces the final audio list on one original card, retaining images and generation settings |
| | `delete_preview`, `delete_apply` | Inspect exact authorized targets then delete once; pre-execute inspection hook, stale refusal and readback |
| | `select_assets` | Free and forced to `isGenerate=0`; needs `idempotency_key` |
| | `prepare_video` | Free and read-only remotely; writes one local preview file |
| | `generate`, `submit_video`, `erase_subtitle` | Billable and irreversible; need `idempotency_key` |
| | `submit_video_batch` | Billable per storyboard; each `video_previews` item needs its own fingerprint key |
| `jubian_video` | `task`, `tasks`, `subtasks` | Read-only, no charge |
| | `image_generate`, `upscale` | Billable and irreversible; need `idempotency_key` |
| | `image_generate_batch` | Billable and irreversible for every item; each item needs its own `idempotency_key` |
| | `retry` | Changes provider task state; needs `idempotency_key` |
| `jubian_media` | `download` | Free and credential-free; writes one local file |
| `jubian_watch` | `task_id`, `stage` | Read-only background observation; returns a process-local job ID |

- `jubian_catalog` reads the account model catalogue for a task type (`task_type` 1 video, 2 image, 10 subtitle erasure), one pricing standard by `standard_id`, a screenplay identity by `script_id`, and its paged episodes.
- `jubian_find` locates a screenplay by name without being told its `script_id` first, in one of two scopes: `mine`, the caller's own canvas projects (`GET /aigc/script/list`), and `pool`, the claimable pool (`GET /script/center/pool/list`). `name` is optional and matches a trimmed, whitespace-collapsed, case-insensitive substring of `script_name` or `manuscript_name`; there is no pinyin, alias or fuzzy matching, so a near miss returns nothing rather than a plausible wrong project. Omitting `name` lists that scope's first page instead of failing. `page_size` bounds one request and not the scan, so the call reads pages until it has covered `total`, an empty page arrives, or it reaches `scan_page_limit`; `complete: false` means the scan did not cover `total` and must not be read as "that is all", and `scanned_pages`, `returned` and `truncated` report what actually happened. `status` is forwarded verbatim, only for `pool`. `production_type` and `share_target_type` are forwarded verbatim as `productionType` and `shareTargetType`, only for `mine`: the console's own request when it opens 漫剧视频 carries `productionType=0` and `shareTargetType=1` against this same `/aigc/script/list`, so that parameter pair is what lists the comic-drama projects. Both values are the provider's own codes — the tool interprets neither, validates neither and defaults neither, so an omitted one is simply absent from the query. It writes no ledger line, needs no `idempotency_key`, changes nothing remote, and does not claim a screenplay out of the pool; a payload it cannot read fails as `CONTRACT_CHANGED` rather than reading as no match, so a missed screenplay and an absent one stay distinguishable.
- `jubian_asset` reads one asset, a paged project asset list, the confirmed casting materials, or the generated image URL of an asset. `confirm_casting` takes the generated material id — not the parent asset and not a task id — and adopts that material for this production. `remove` issues `DELETE /aigc/asset/removeAsset/{assetId}?scriptId=<id>&isParent=1`: the parent asset and its media versions are removed, the shot matches that referenced it are not rebuilt, and already generated video is not regenerated. Cancelling a casting decision is a different operation; `remove` is not it. `upload_reference` takes a local `image_path`, verifies both edges are multiples of 16 (the rule the provider's own image pipeline needs), uploads to the destination the live frontend bundle configures, and returns the `materialUrl`/`materialType`/`sortOrder` item an asset request or `image_generate` `references` list needs. It charges nothing and creates no task, but it does write an object into the provider's bucket. The three library writes are described under "Organizing the asset library".
- `jubian_organize` builds one read-only view of a project: which episode uses which character, scene and prop, with each asset's remote identifiers and status; the naming audit; the category audit; and the folder tree of each personal-library category. It changes nothing remote and writes one local index file. It is described under "The organization index".
- `jubian_storyboard` lists project storyboard identities without requiring model settings or local project files, reads one storyboard, creates one from a complete request body the caller supplies, saves without generating, submits generation, or erases burned-in subtitles. `generate` reads the current storyboard snapshot, sets `isGenerate=1`, and writes it back, so it also requires `content_duration_ms` equal to the duration already saved on that storyboard; a mismatch fails before any request leaves. `erase_subtitle` needs the task id, the video frame size and an explicit `model_id`: `quzimuToB` (regional — the erase rectangle defaults to the provider's own proportion of the frame, so `subtitle_box` is optional and normally omitted) or `ark-erase-video-subtitle-pro` (automatic, rejects `subtitle_box`). It has no default model, so a caller that omits `model_id` is told which argument is missing instead of having a model chosen for it. The project, episode and source identities are read from the task and its child results, so `script_id` is not required. The three storyboard-native methods are described in the section below, "The storyboard-native video channel".

`delete_preview` requires exact `storyboard_ids`, the user's `authorization_basis` and a concrete `delete_reason`. It reads card contents and associated tasks, then freezes a project-bound preview. The pre-execute Hook requires the agent to inspect these targets and supply every `checked_storyboard_id` before `delete_apply`. Apply refuses any changed card or task, active generation, and linked generated media unless the preview explicitly includes its authorized removal. The provider's `DELETE /aigc/storyboard/{id}` endpoint is confirmed by its public storyboard page (`chunk-7652bf40.2c84d891.js`, module `917c`, September 30, 2026). Each write is logged as `storyboard_remove`; response loss stops the remaining batch and triggers readback. Replaying the same plan performs reads only; unattempted targets require a fresh inspection. Each result separates the saved provider response (`response_status`) from current deletion confirmation (`verified_readback`); replay validates the per-card ledger method, project and request hash. The linked-task read must cover its complete reported total; partial pages cannot authorize deletion. Apply accepts only the canonical prepared file for the fingerprint in this project and rejects symlinks before reading it. Remote removal is irreversible.

`create_batch` accepts one project `script_id` and a `storyboards` array of independently keyed `body` or `body_path` entries. It reads and checks every entry before any POST, then creates with `isGenerate=0` using `storyboardBatchConcurrency` (default 4, range 1–8); `storyboardBatchMaxItems` defaults to 1000, range 1–1000. Each result retains its index, name, key and ledger outcome. A partial or ambiguous result requires reconciliation with the original keys; successful entries are not recreated. Read back each created storyboard before selecting materials and preparing the whole video batch.

Use `edit_preview` for one existing `storyboard_id`, or `edit_batch_preview` with `edits` entries containing explicit IDs and `changes`; both require the bound `script_id` and `project_dir`. Changes accept prompt, saved model settings, `name`, `episode_id` and `sort_order`. Prompt is saved inside `modelConfig`; an explicit episode repair must name an ID in this project's live episode catalogue. Review before/after values, then call `edit_apply` with the returned `preview_path` and `idempotency_key=fingerprint`. The edit rejects stale cards, preserves identity, ordered materials and other provider fields, and sends only free `isGenerate=0` PUTs under the creation batch limits. Readback confirms the saved values and preserved materials. Changed prompt markers return `needs_reselect`: the approved text is saved and the materials are retained. An account-local ledger record blocks preparation and new submissions until `select_assets` verifies the mapping, including a renamed marker with the same key. This record applies to this ledger, not another device. An unknown result is reconciled with the original preview and key; replay sends nothing. Edit apply validates the canonical prepared path and rejects symlinks before reading the preview. Use creation for genuinely new packages.

The saved prompt is `modelConfig.prompt`, not a top-level `prompt`. Put each `@[name](material_key)` reference once in the prompt mapping, in selection order. `get.material_keys` reports already bound material rows; an empty value on a new storyboard does not establish that its prompt is absent.

`jubian_storyboard list` takes `script_id` and optional `page_num`/`page_size`; it returns `storyboards.rows`, `total` (null when unavailable), and the requested page. Empty projects return an empty list. An unbound episode is exposed as `episode_id: null`; rows from another project are rejected. Continue through the reported total, or until an empty page when no total is available. Use `get` for details. Model `preview` requires saved settings or explicit `changes`; missing fields and missing episode bindings name the affected storyboard. It is not a discovery method.

For `create`, use `scriptId`, the actual `episodeId` from `jubian_catalog episodes`, display `episodeCount`, `scriptName`, `storyboardName`, zero-based `sortOrder`, and `isGenerate: 0`. Encode `modelConfig` as JSON containing the complete package prompt and current catalog selectors (`modelId`, `platformId`, `standardId`, `genType`, `modelGenerationTypeId`, `videoStandardId`, `ratio`, `resolution`, `genNum`) plus its integer-second `duration`, including the ending hold. Do not copy an existing record ID, account fields, or task list. After creation, read the returned ID and bind materials through `select_assets` before preparing video. Each body can be frozen under the project `video_tasks/` and supplied through `body_path`.
- `jubian_video` reads one task (including its observed cost), a project's paged video tasks, or a task's sub-results, which carry the finished `video_url`, the subtitle pixel box, the stage history, the resolution of each result and the `needs_upscale` verdict. `subtasks` carries its query in a `POST` body and still only reads. `image_generate` builds a billable asset image: `asset_name`, the asset's category, `prompt` and optional ordered `references` are required, and a supplied `parent_asset_id` regenerates that asset through `PUT` instead of creating a new one through `POST`. The write is asynchronous, so the method then reads the new asset back until `hsAssetStatus` is `Active` and returns its `material_id` — the id `confirm_casting` takes — with its `image_url`; see "The paid image route" below. `upscale` submits one billable 1080p conversion (SeedVR2 video upscale, 1 CNY per clip) and takes `task_id` plus `idempotency_key`; every other identity is read from the parent task and its first child result. `retry` re-executes one terminal, uncharged failure; it reads the parent task and its children first and refuses to send anything unless the parent is terminally failed, no child holds a file or an active/succeeded state, and the task carries no real cost.
- `jubian_media` downloads one provider medium to `output_path` and returns the path, detected media type, byte count and sha256. It never puts the bytes into the result: tens of megabytes of base64 would poison every later request.

### Account pool claims

`jubian_claim.inspect` reads one ID's account-specific `can_claim` without writing. `jubian_claim.claim` requires an explicit user authorization statement, the same screenplay ID and caller-supplied `idempotency_key`; it reads `viewRole`, scans the complete pool and sends one POST only while that ID carries `canClaim=1`. A leader uses `/script/center/pool/claim/{id}`, a member uses `/script/center/pool/memberClaim/{id}`, and an unknown role is refused. The ledger records a bodyless claim attempt before submission. A timeout or unclear receipt is read back against the authenticated claimant ID; no second key for that screenplay sends another request from this ledger.

`jubian_snatch` starts a process-local job for an explicit UTC start/end window. `scope=ids` requires an authorized ID list; `scope=new_claimable` takes a complete pool baseline on start and considers only newly seen `canClaim=1` rows. It derives each claim key from the caller's `idempotency_prefix` and the ID, stops at the configured window or item limit, and reports individual results through `job_output`. These tools never infer authorization from a list result. The bundled [jubian-snatch skill](../../../apps/desktop-host/skills/jubian-snatch/SKILL.md) requires the agent to check the user's original instruction before any claim; a supplied summary is recorded in the tool call but is not independent proof of consent. Host restart ends the job without resuming it.

### Background operation watching

Call `jubian_watch({ task_id, stage })` after submission returns the accepted **operation** task ID; do not substitute the source video task ID. `task_id` must be a positive safe integer and `stage` is `generate`, `upscale`, or `erase_subtitle`. Admission immediately returns `{ job_id, task_id, stage, status: "running" }`. Missing `jobs` fails this tool only; admission also requires an attached job controller. The watcher reads only that task and its paginated child results, without ledger writes or paid retries.

Completion requires a succeeded operation of the requested type and a complete, uniquely identified child list owned by that operation. Every child must succeed and identify an output of the requested stage; an owned generation's original file needs no downstream-stage marker. Missing IDs, unknown stages, incomplete totals, old source success, and historical upscale flags cannot establish completion. These observations remain unverified until the configured deadline fails the job. Provider failure and read failure also fail the job; none authorize another paid submission.

The existing [job tools](../../jobs/tool-jobs/README.md) deliver a completion notice by waking an idle Agent or injecting into a busy Agent. Their `maxConsecutiveWakes` policy (default 3) still applies; the watcher does not bypass it. Collect the result with `job_output`; `job_kill` aborts polling and its in-flight read, not the provider operation. Watches and job IDs belong to the current process and do not survive a restart. The returned outputs require frame/audio review and delivery-resolution checks; provider success and subtitle-stage evidence are not visual QA.

### The naming convention

The provider exposes no group, tag or episode field on an asset, so the two things a caller controls about how the console presents an asset are its name and, since this package gained the library writes, its folder. This row composes both.

```text
EP05｜道具｜红包
全剧｜角色｜陆沉舟
EP05-P3-sb12-去字幕
```

The first two are asset names; the third is a processing task's, sorted by episode and then by package. The composition is opt-in per call: a caller that passes `episode` gets it, and a caller that does not gets its own `asset_name` and `task_name` byte for byte, so every call written before this feature means exactly what it always meant.

| Argument | Where | Effect |
|---|---|---|
| `episode` | `image_generate`, `image_generate_batch`, `erase_subtitle`, `upscale`, `rename` | `5` and `05` both normalize to `EP05`; the configured `seriesLabel` marks a series-wide asset |
| `asset_category` | `image_generate`, `image_generate_batch`, `rename` | `角色`, `场景` or `道具`; supplies the name's middle segment and the provider's `assetType` |
| `package_number` | `erase_subtitle`, `upscale` | `EP05-P3-` in front of the stage's own task name |

`asset_category` is the root-cause fix for a real defect: the earlier schema offered only `asset_type` with evidence for `1`, so a pipeline that created a scene or a prop sent `1` and the console filed it under 角色. Scenes are `2` and props are `3`, the same numbers the library folders use. `image_generate` still accepts `asset_type` for callers that predate the category, and the two must agree — an asset whose name says 场景 and whose type says 角色 fails before any request.

### Organizing the asset library

Three writes reorganize what a person sees in the console. Each takes a caller-supplied `idempotency_key`, and each reads before it writes where the provider's single refusal code could not tell two failures apart.

| Method | Endpoint | Arguments | What it does |
|---|---|---|---|
| `create_folder` | `POST /aigc/assetFolder/add` | `folder_name`, `asset_scope_type`, `root_category_type`, optional `parent_id` | Creates a folder in one category library, then reads the tree back to report its `folder_id` |
| `move` | `PUT /aigc/material/move` | `material_ids`, `target_folder_id`, `asset_scope_type`, `root_category_type` | Moves material rows into a folder, or back to a library root |
| `rename` | `PUT /aigc/material/reName` | `material_id`, `asset_name`, optional `episode`/`asset_category` | Changes an asset's display name; with an episode it composes the conventional one |

`asset_scope_type` is `1` for the team library and `2` for the personal one, and `root_category_type` is `1`/`2`/`3` for 角色/场景/道具 — the same numbers as `assetType`. A folder is created under `parent_id`, or directly under the library root when none is given; the root's own identifier is the category number, which is what the console passes. Moving back out of every folder means naming that same number as `target_folder_id`.

Two refusals are decided locally, before anything is sent: a sibling folder that already carries the name reports `folder_exists` with that folder's id, and a `target_folder_id` the library does not hold reports `target_folder_missing`. The provider's own refusal of a rename or a move arrives as one of the stable failure codes below, because the transport deliberately never echoes provider text into a result.

None of the three touches an image, an id or a category. A rename changes what a person reads; it does not move an asset between the console's role, scene and prop tabs — only regenerating under the right `assetType` does that.

### The organization index

`jubian_organize` `index` answers "what does this project actually hold, per episode" without changing anything. It reads the project's paged asset list, its used subject materials, its video tasks and the folder tree of each category, and joins them with the project's own `assets_manifest.json`.

```text
GET /aigc/asset/list?scriptId=
GET /aigc/material/list?scriptId=&isUsed=1
GET /admin/aigc/video/task/list?scriptId=&taskType=1
GET /aigc/assetFolder/tree?assetScopeType=2&rootCategoryType=1|2|3
<project_dir>/assets_manifest.json
```

The asset list is paged to the end; the manifest is the episode map. A manifest row's `type` may be spelled as the convention's word in either language (`character`/`角色`, `scene`/`场景`, `prop`/`道具`) or as the provider's own category number (`1`, `2`, `3`), because both name the same three categories. A row this cannot read fails the whole call with the entry and the field named: `<path> 的第 3 条资产（酒店大堂）的 type="unknown" 不是 character/角色、scene/场景、prop/道具，或类别号 1/2/3`, or, when the field is genuinely absent, the row's own key names. The document-level failures name the structure actually read as well, so a manifest whose assets live under an unexpected key reports that key instead of claiming an asset is missing a name.

The result carries four things, and the same content is written to `<project_dir>/<assetIndexPath>`:

- `episodes` — one entry per episode, each with `categories` (角色/场景/道具) listing the assets that episode uses, their `asset_id`, `material_id`, manifest status, remote name and remote status, plus the video tasks whose name carries that episode token.
- `series` — the assets the manifest declares with no episode number, which are the cross-episode masters. An `episodes` entry of `all`, `*` or the configured `seriesLabel` declares the same thing — the asset serves every episode rather than one — so it lands here instead of failing the read.
- `naming_violations` — every remote asset and material name that does not read as `EP{nn}｜{类别}｜{名称}` or `全剧｜{类别}｜{名称}`, with the reason. It reports; it never renames.
- `category_mismatches` — every asset whose provider `assetType` disagrees with the category its manifest row declares or its own name declares (a name segment of 场景/道具, a `scene_`/`prop_` prefix, or a 日/夜 scene slug). This is the list the 77 scenes and 21 props created under `assetType` 1 appear in.

Nothing here is automatic. A caller that wants to act on either list uses `rename`, `create_folder` and `move` — after asking the user, because these are names and positions a person is already reading.

### Scoped model settings

Use `jubian_model preview` with `project_dir`, its bound `script_id`, an explicit `scope`, and a nonempty `changes` object. `storyboards` takes exact remote `storyboard_ids`; `episodes` takes remote `episode_ids`, not displayed episode numbers; `project` means all existing storyboards, never future defaults. Changes retain unspecified intent and resolve fresh selectors from the live catalogue. Changing `modelId` without `platformId` requires one unambiguous compatible platform, rather than retaining the old platform. Preview returns every before/after setting and writes `<project_dir>/video_tasks/<fingerprint>.model-settings.prepared.json` without any remote write.

After the user approves the scope and settings, call `apply` with the same project binding, `preview_path`, and `idempotency_key` equal to `fingerprint`. It rejects edited plans, changed membership, stale targets or changed catalogue selectors before the first write, then rereads each target immediately before its `PUT`. Every body comes from that live target, changes only model settings, and forces `isGenerate=0`. Readback checks settings, prompt, asset identity/order and nonmodel values. Errors stop the remaining targets and return per-item outcomes; replay only reconciles attempted targets and never resends or resumes the plan. Produced media and future project defaults remain unchanged.

Project and episode previews report malformed cards in `excluded_invalid` and plan only valid members. An orphan with no usable `episodeId` does not block unrelated episodes. Exact `storyboards` scope still reports that card's error; repair its explicit episode binding or duration with `edit_preview` and preview the intended model scope again. Displayed `episodeCount` is never inferred as a remote episode ID.

### The storyboard-native video channel

Register uploaded voices with `jubian_asset register asset_type=4`. `audio_list` and `audio_get` read project audio identities and URLs without guessing duration. Registration matches project, name and URL across complete inventories; ambiguous results cannot supply a guessed ID. Same-key reconciliation never registers again. `jubian_storyboard audio_preview` accepts the original card ID, project binding, complete prompt and final ordered `audio_references`; `[]` removes all audio. Optional `audio_asset_id` verifies project/category/URL without inventing provider material IDs. `audio_apply` requires the same original ID, reviewed fingerprint and key; it sends one `isGenerate=0` PUT, preserves images, model, duration and episode, then checks actual readback. Unknown writes only reconcile under the original key. Refresh `prepare_video` after changes.

Audio deletion requires `audio_delete_preview`, an exact authorized ID and reason. It enumerates the asset's media versions and checks current project-bible voices and all project cards; incomplete or unreadable inspection refuses deletion. Remove or replace references, then preview again. `audio_delete_apply` requires `checked_audio_asset_id` and the preview fingerprint as key; it rechecks the target and references, deletes once, then independently verifies absence. Generic `remove` refuses audio. Deletion excludes local audio_apply and project-bible writers through readback. Other write tools and external console edits do not participate in those locks; avoid concurrent reference changes during deletion. Deletion does not cancel or refund historical jobs. `audioReferencePageSize` (default 1000, range 1–1000) and `audioReferencePageLimit` (default 100, range 1–100) bound complete scans.

For voice continuity, load [the voice reference skill](../../drama/skills/skills/tweet-drama-voice-continuity/SKILL.md). `jubian_asset upload_audio` accepts `audio_path`, measures the actual 16-bit PCM WAV samples, refuses files longer than 15 seconds before uploading, and returns `materialUrl`, `audioDuration`, SHA-256 and `duration_verified: true`. It creates no asset or generation task. Existing uploaded audio remains bound when `select_assets` updates image selections; audio has its own group order and no image parent ID. Native preparation freezes those references and reports saved duration separately from byte verification; unknown remote duration stays unverified. Submitted audio must reappear in ordered child `audioMaterials[].audioUrl` before a task is claimed. Repair and save the original storyboard when a reference is wrong.

A subject-backed video is created by the provider from a storyboard `PUT` with `isGenerate=1`; a direct task `POST` does not preserve subject identity. Production evidence isolates that difference: task `335343` came from the storyboard `PUT`, retained all seven identities, and succeeded, while `335470` came from direct `POST /admin/aigc/video/task/create`, lost `assetId`/`materialName`, and failed. That route is therefore unsupported here, and there is no method that calls it.

The only normal order is three calls:

```text
select_assets  (isGenerate=0, free)  -> prepare_video (free, local preview) -> submit_video (one PUT, paid)
```

- `select_assets` saves an ordered subject selection. Each `material_key` must appear in the prompt's own `@[name](key)` order, every selection must resolve to exactly one active subject-setting row and one parent asset in the same project, and the row's trusted `hsAssetId` is what the provider will translate into the child task's identity. The body is always forced to `isGenerate=0`. After the single `PUT` the row re-reads the storyboard as well as the project's task list: a saved order that disagrees with the plan is an error, and a video task that appeared across a selection-only save is reported as `billing_safety_violation` so a caller stops rather than continues.
- `prepare_video` is free and read-only on the provider. It checks `project_config.json` in `project_dir` against the live `scriptId`, hydrates ordered images from the live storyboard, the subject picker and the parent assets, preserves uploaded audio, the saved model, platform, ratio, resolution and duration, and resolves their exact current catalogue selectors with `genNum=1`. Seedance 2.0 (`doubao-seedance-2-0-260128`) accepts 4–15 total seconds; Seedance 2.5 (`doubao-seedance-2-5-260628`) accepts 4–30. Total duration includes at least one second of natural ending; unsupported or ambiguous selections fail without a default substitution. It writes one preview into `<project_dir>/video_tasks/storyboard-<id>-<key12>.storyboard-native.prepared.json` through a temporary file and a rename. It sends no `PUT`, creates no task, and charges nothing.
- `submit_video` takes that `preview_path` and an `idempotency_key` that **must equal the preview's own fingerprint**. A mismatch, a stale preview (the live semantics changed since it was written) or a preview that is not this plugin's own fails before anything is sent. Otherwise it takes a complete, paged task snapshot, refuses to continue if a second read of that snapshot drifts, sends at most one `PUT /aigc/storyboard` with `isGenerate=1`, and takes a second snapshot to claim the one new task whose ordered `assetId`/`materialName`/`imageUrl` and model/prompt evidence match the preview exactly. A task row counts as a candidate for that claim — before or after the `PUT` — only when it is provably this storyboard's: the row states its `storyboardId`, its detail does, or one of its child results does. A project holds every storyboard's tasks and most rows state no `storyboardId` at all, so a row that proves none of the three belongs to another storyboard and is neither a match nor unsafe evidence.
- `submit_video_batch` accepts `video_previews: [{preview_path, idempotency_key}]` for distinct storyboards in one project. The agent must prepare and review the requested range and include every intended preview in this submission list; the tool can verify the supplied list, not detect omitted storyboards. It validates every listed preview against its live storyboard, checks existing tasks and two complete project snapshots, then reserves the whole batch estimate under one same-process ledger claim before sending any PUT. A stale preview, duplicate storyboard/key, drifting or malformed task list, existing task conflict, or insufficient aggregate budget sends zero PUTs. Once all reservations exist, it sends up to `videoBatchConcurrency` independent storyboard PUTs at once and independently limits reconciliation reads to the same concurrency without occupying PUT slots. It reads each task as soon as its PUT returns, then uses a final project snapshot and each item's storyboard, ordered subject, model and prompt evidence to report ordered results. `submitted` requires intact final identity; an unknown PUT or stripped readback is `reconcile_required`, never permission to resend. A replay with all original keys performs read-only reconciliation. Mixed recorded and new keys are refused; reconcile each old key before making a new approved batch. The ledger queue is process-local, as for single paid writes.

Before reading task details and children, submission and reconciliation exclude rows with an explicit valid episode id different from the preview's. Missing or malformed episode ids remain candidates. The 100-candidate hydration cap, full task snapshots, and one-PUT ledger protection remain in force.

The verdicts are the contract. `submitted` means one task was claimed with its identity intact; `subject_identity_lost` is terminal — the child kept URLs but lost an identity field, and the answer is inspection, never a second `PUT`; `reconcile_conflict` means more than one candidate or incomplete evidence, which is also never a retry signal; `reconcile_required` means the one `PUT` happened but no task is visible yet, and re-calling with the same preview and key only re-reads. A `PUT` that fails for any reason — timeout, `5xx`, connection loss — is recorded with `outcome: unknown` and `put_ambiguous: true`: no automatic retry exists, and the same key can never send a second `PUT`.

Because the key is the preview's fingerprint, the same preview file can cause exactly one request in its lifetime. A preview is therefore **not** interchangeable with the CLI's own prepared file: the two serializers hash different JSON text, so a preview written by one is refused as stale by the other.

### The paid image route

`image_generate` is one paid write followed by a free readback, and which catalogue row it writes against is a deployment decision rather than a guess:

`image_generate_batch` takes one `script_id` and 1–12 `items` by default. Each item supplies its own key, name, prompt, category or type, and optional episode, references, parent asset ID and platform. The method validates every local item before any network or ledger work, refuses duplicate keys, final asset targets and parent IDs, then submits up to three paid requests concurrently by default. After all submissions return, it reads the accepted assets back with the same concurrency bound; slow image polling does not hold a submission slot. Several new assets may share one confirmed identity image URL in `references`; `parent_asset_id` instead updates the same remote asset through `PUT`, so repeated parent IDs conflict. Each item uses the same budget reservation and ledger as `image_generate`; an item error does not hide the others. Replaying either a single image request or a batch item reads the current catalogue and compares the full request body and project with the prior ledger hash; a changed asset, prompt, reference or selected model row is refused without resending. The ordered `results` include each requested identity, `status`, `outcome`, `response_sha256`, and either the image readback or a per-item error with reconciliation guidance. `status: returned` and the aggregate `returned` count mean that the call returned; only `asset_status: active` means the image is ready. A readback failure retains the accepted `parent_asset_id` for later lookup. `not_sent` means no ledger intent exists; `accepted` with an incomplete image still needs a readback, and `unknown` must be reconciled before another paid request.

One read of the live model catalogue resolves every item's selected row before a paid request starts. If a selected platform is missing or ambiguous, the batch refuses all submissions. An item error reports the prior `record_id`, `record_script_id` and `request_sha256` when that key already has a ledger record. The error's `outcome` belongs to that record and does not confirm the newly requested asset.

```text
pin the gpt-image-2 row (short-drama settings page, else imagePlatformId / imageStandardId)
  -> POST (or PUT) /aigc/asset                          paid, accepted with the new asset id
  -> GET /aigc/asset/{id}                               free, until hsAssetStatus is Active
  -> GET /aigc/material/getGeneratedImageByAssetId      free, the material id and the image URL
```

The write returns before the asset has an image, and a measured asset reached `Active` one to two minutes later. The result therefore reports `asset_status` instead of leaving the caller to read acceptance as a picture:

| `asset_status` | Meaning | What the caller does |
|---|---|---|
| `active` | The asset read `Active` and its generated image was read | Use `material_id` for `confirm_casting` and `image_url` as the file; only now is it safe to save or review the image |
| `timeout` | The readback budget ran out before `Active` | Nothing was resent; re-read with `jubian_asset` `get` or `generated_image` later, never with a new key |
| `failed` | The provider marked the asset terminally failed | Regenerate under a new `idempotency_key` |
| `replayed` | The key already had a record, so nothing was sent and nothing was read | Read the asset with `jubian_asset` |
| `unverified` | No asset id came back, or the write was not accepted | Read `jubian_asset` `list` before concluding anything |

A timed-out readback is reported, not thrown: the paid write was already accepted and the ledger already records it, so an exception would present a completed charge as a failed call. Every non-`active` result carries `readback_error` naming what was and was not established, and `parent_asset_id`, `model_selection` (`standard_id` and `platform_id`, the row actually bought from), `observed_asset_status` and `waited_ms` either way.

### Writing safely: idempotency and the ledger

Every write method requires a non-empty `idempotency_key`; `image_generate_batch` requires one on each item instead of at the top level. No method generates a key, because a generated key would let a retry after an ambiguous outcome bypass the record of the first attempt.

Repeating a key never repeats a write. Ordinary writers return the recorded outcome with `replayed: true` without compiling a body or reading the provider. Batch images verify the current request against the recorded body hash before returning a replay; a mismatch is refused. `submit_video` and `jubian_model apply` instead perform read-only reconciliation; model configuration plans never resume their remaining targets.

The ledger lives at `<ledgerRoot>/YYYY-MM-DD.ndjson` and appends in two phases:

- before the request leaves, one `intent` line with the key, the method, an `sha256` of the request body and any quote snapshot;
- after the response is read, one `settle` line with `http_status`, `application_code`, `response_sha256` and `outcome`.

An intent line without a settle line is the unknown state a timeout leaves behind, and it is the only evidence for whether that call was charged. `outcome` is `accepted` only when HTTP is 2xx and the envelope `code` is `0` or `200`; every other case is `unknown`.

### Errors

Transport failures arrive as one of five stable codes and never carry the provider's response text or a token.

| Code | Trigger |
|---|---|
| `AUTHENTICATION_REQUIRED` | No token, interior whitespace in the token, HTTP 401 or 403, or envelope `code` 401 or 403 |
| `PERMISSION_DENIED` | Envelope `code` 403 while HTTP is 2xx |
| `RATE_LIMITED` | HTTP 429 or envelope `code` 429 |
| `CONTRACT_CHANGED` | Non-JSON object, invalid UTF-8, byte cap exceeded, unexpected envelope shape, or a missing reader field |
| `INVALID_ARGUMENT` | The caller omitted an argument its method cannot run without; the message names it |
| `NETWORK_ERROR` | Connection failure, timeout, refused redirect, or any other non-2xx status |

### Submitting an asynchronous stage

`upscale` posts to `/aigc/storyboard/hdConversion` with the source identities and SeedVR2 selectors; it sends no `videoResolution` field. An `unknown` record from any endpoint, including an incorrect path, remains protected by the same ledger key after a route repair. Reconcile provider tasks and charges before considering another submission; changing the path never authorizes a new key ([route evidence](../../../.agents/notes/implemented/bug-fix/2026-09-21-jubian-upscale-route.md)).

Erasure and upscaling are asynchronous provider tasks. `erase_subtitle` and `upscale` return as soon as the provider accepts the task, with the accepted task id; a measured upscale run took minutes to more than ten of them.

```text
submit -> receive the accepted task id -> do other work -> re-read subtasks
```

`needs_upscale` only compares actual resolution with `delivery_resolution`: `true` means below target, `false` means at or above it, and `null` means unknown. It neither declares content unusable nor creates a paid-processing obligation. SD2.5 uses the original clip by default, without automatic HD submission or waiting. No model authorizes paid processing merely through `needs_upscale=true`; call `upscale` only when the user explicitly requests or authorizes the specific HD operation, including for SD2.5. Report ordinary export dimensions separately from the real source resolution; local scaling does not restore source detail.

After an authorized submission, do other work and read `subtasks` later; use the operation watcher above to verify completion rather than the initial response.

`image_generate` is the one exception, and only because its result is unusable without it: that method waits inside the call for its own asset to reach `Active`, bounded by `imageActiveTimeoutMs`, and reports the timeout as `asset_status: timeout` instead of throwing.

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

This section explains how the row is built; the observable behavior is fully covered in [Use this package](#use-this-package).

### Design philosophy

The package is built on three decisions:

- **The description carries what the schema cannot.** Each tool description states in the model's own reading language which methods cost money, which verbs lie, and that a timeout never means "safe to retry". The registry types and validates arguments; the description carries the operational facts.
- **Paid writes need a project ceiling.** The shared ledger path refuses a paid call without either a matching `<ledger>/authorization.json` entry or the mounted drama section's automatic per-series CNY cap. A replayed key does not send again. Neither the writable file nor the settings document proves human approval; deployments needing user-owned consent must enforce it independently.
- **The transport owns the wire, the ledger owns the money question.** Credential resolution, envelope normalization, error classification, redirects and byte caps live in `dsh-jubian`. The two-phase ledger and the lazily compiled bodies live here, because this is the layer that knows which methods write.

### Source map

| File | Role |
|---|---|
| [`src/index.ts`](src/index.ts) | Plugin entry: the `Config` interface, the ledger, client and naming construction, the credential fallback, the twelve `ctx.tools.register` calls, and the shared argument and output contracts |
| [`src/methods.ts`](src/methods.ts) | One async function per tool: method dispatch, request shaping, and the local media write |
| [`src/find.ts`](src/find.ts) | The screenplay-name lookup: the two scope paths, the shared name normalization, and the bounded scan behind the `complete` verdict |
| [`src/claim.ts`](src/claim.ts) | Account pool inspection, one-shot ledger-backed claim, and bounded background claim window |
| [`src/naming.ts`](src/naming.ts) | The episode-and-category convention: name composition, the provider's category numbering, and the two audits |
| [`src/folders.ts`](src/folders.ts) | The three asset-library writes: folder creation, the move, the rename, and the two locally decided refusals |
| [`src/organize.ts`](src/organize.ts) | The read-only organization index: the paged reads, the manifest join, the markdown rendering and the atomic local write |
| [`src/write.ts`](src/write.ts) | The two-phase `writeUnderLedger` helper, the request-body hash and the required-key check every write path shares |
| [`src/native.ts`](src/native.ts) | The storyboard-native flow: the paged dual snapshot, the single `PUT`, task claiming and the atomic preview write |
| [`src/storyboard-edit.ts`](src/storyboard-edit.ts) | Frozen existing-card edits, selection diagnostics and verified free saves |
| [`src/reference.ts`](src/reference.ts) | The local reference upload: file reading, the optional `ffmpeg` re-encode, the frontend bundle read and the signed object `PUT` |
| [`src/token.ts`](src/token.ts) | The `jubianToken` Remote namespace over the one credential reference, mounted beside the tools by `apply` |
| [`src/image.ts`](src/image.ts) | The paid image route's pin — the `drama` settings row over this row's config, resolved per call — and the read-only `jubianImage` Remote namespace that lists the rows a person may pin |
| [`src/client/mount.ts`](src/client/mount.ts) | The browser half: the generated Remote contribution's mount lifecycle, the Settings registration and the injected face |
| — | No runtime invariant companion is published because this model-facing adapter owns no independent lifecycle stream; the execution relations belong to the capability seams it calls. |

### Write path

A write method first rejects a missing key, then asks the ledger whether that key already exists. A hit returns the stored outcome without compiling a body and without a network request. A miss compiles the body — possibly by reading the provider, as the image generator does for its live selectors — takes the quote snapshot, appends the intent line, sends exactly one request, and appends the settle line. A thrown request also appends a settle line with a null status, so the file always shows that the attempt left the process.

### Read path

Read methods never touch the ledger. Each sends one request and passes the envelope's `data` to a reader from `dsh-jubian-api`, which returns a normalized object with named fields instead of the provider's raw shape. Unknown provider values stay visible as `null` rather than being guessed, which is why `needs_upscale` can be `null`: an unrecognized resolution label has no honest verdict.

</details>

-----

<a id="further-exploration"></a>
## Further Exploration

Read these pages when the package-level contract is not enough. They move from the generated catalogues to the two packages underneath this row and the credential rules it depends on.

- [Generated tool catalog](../../../docs/tool-catalog.md#deepseek-aidsh-tool-jubian) — the exact schema and description of all twelve tools.
- [Generated configuration catalog](../../../docs/config-catalog.md#deepseek-aidsh-tool-jubian) — every accepted config field and its source declaration.
- [dsh-jubian transport source](../jubian/src/index.ts) — the client, the five stable failure codes, credential repair, and the write ledger this row builds on.
- [dsh-jubian-api](../jubian-api/README.md) — the readers and request builders behind every method.
- [dsh-credentials](../../credentials/credentials/README.md) — the reference and record seam, and the resolution order.
- [Credential records and authorization flows](../../../.agents/notes/implemented/architecture/2026-08-13-credential-records-and-authorization-flows.md) — why a token value is provider-managed.

-----

<a id="model-experience"></a>
## Model Experience

### Tool schemas

#### What the model sees

The model sees `jubian_catalog`, `jubian_find`, `jubian_claim`, `jubian_snatch`, `jubian_asset`, `jubian_organize`, `jubian_model`, `jubian_storyboard`, `jubian_video`, `jubian_media` and `jubian_watch` as generated in the [tool catalog](../../../docs/tool-catalog.md#deepseek-aidsh-tool-jubian). Each schema is one open JSON object whose required selector is the `method` enum on dispatching tools and the call's own required argument elsewhere. The claim tools make the authorized ID or range, UTC window and user authorization basis explicit. Parameter and enum descriptions are plain Chinese text because they address the model rather than a localized UI. Numeric codes appear where the provider defines them — `task_type` (`1` video, `2` image, `10` subtitle erasure), `asset_type` and `asset_category` (`1`/`2`/`3` for 角色/场景/道具), `asset_scope_type` (`1` team, `2` personal), and `subtasks` `hd_count` / `last_task_type` / `resolution`.

#### Token effect

Fixed per request while the row is mounted: twelve tool definitions with their enum and argument descriptions, and no prompt section. Enabling or removing the row is the only lever on this cost.

#### KV Cache effect

Prefix-stable while the mounted tool set and the package version are unchanged; a package upgrade, a mount change, or a serialization change to any description may invalidate reuse from the first changed definition token.

### Idempotency contract in the descriptions

#### What the model sees

Every write method's description states that `idempotency_key` is required (on each item of `image_generate_batch`), that repeating the same request and key sets `replayed: true` without repeating a write, and that a timeout or unknown result means re-calling with the same key rather than a new one. A different request cannot reuse that key. The read methods accept no key.

#### Token effect

A fixed addition to each write method's description, repeated in the shared `idempotency_key` argument description; no prompt tokens.

#### KV Cache effect

Prefix-stable while the description text is unchanged. Editing these sentences is a package change, so it invalidates reuse from the first changed tool definition.

### Cost and side-effect warnings in the descriptions

#### What the model sees

The descriptions name `jubian_video` `image_generate`, `image_generate_batch` and `upscale`, `jubian_storyboard` `generate`, `submit_video` and `erase_subtitle`, and `jubian_asset` `remove` as billable or irreversible, and state that `confirm_casting` changes provider state through a `GET` even though the verb suggests a read. `jubian_video` `subtasks` states that its `POST` only reads. `jubian_video` `image_generate` additionally states that it reads the asset back to `Active` before returning, what each `asset_status` value means, that a catalogue listing several `gpt-image-2` rows fails while no row is pinned, that the pin is a person's choice on the 短剧 settings page or an `imagePlatformId`/`imageStandardId` config value, and that the model must relay the candidate list to the user rather than pick one, and that the category decides `assetType` so scenes and props must not be sent as 角色. `image_generate_batch` states that each item is charged and recorded independently and that `status: returned` does not mean its image is ready. `jubian_asset` states that `create_folder`, `move` and `rename` really write, that a duplicate folder or a missing target folder is reported instead of sent, and that a batch rename or move needs the user's explicit consent first. `jubian_organize` states that it is read-only, renames and moves nothing, and still writes one local index file. `jubian_storyboard` states the whole storyboard-native order, that `select_assets` is forced to `isGenerate=0`, that `prepare_video` neither `PUT`s nor charges, and that the direct task `POST` is forbidden. The async methods state that they return on acceptance and that completion is read back later from `subtasks`.

#### Token effect

Fixed description text per tool; the paid tools carry the longest descriptions in the package. No prompt tokens and no result tokens until the model calls them.

#### KV Cache effect

Prefix-stable while the mounted set and these descriptions are unchanged; a package change that rewrites them invalidates reuse from the first changed definition.

### Tool results

#### What the model sees

Every call returns one pretty-printed JSON object under a shared open-object output schema, keyed by the method that asked for it (`asset`, `assets`, `storyboard`, `subtasks`, `task`, and so on) plus the model's guidance fields; `jubian_find` alone keys its result by the scope it scanned. Write results carry `replayed`, `outcome`, `response_sha256` and the envelope data; `erase_subtitle` and `upscale` add `accepted_task_id` and a `next` line telling the model not to wait. `image_generate` returns `parent_asset_id`, `model_selection`, `asset_status`, `material_id`, `image_url`, `observed_asset_status`, `waited_ms`, `readback_error` and a `next` line, so a model reads the image's identity from the result instead of assuming acceptance produced one. `create_folder` returns `sent`, `status`, `folder_id`, `confirmed` and a `next` line; `move` and `rename` return `sent`, `status` and a `next` line, and either of the two refusals returns `status: folder_exists` or `status: target_folder_missing` with `sent: false` and the id it looked for. `jubian_organize` returns `episodes`, `series`, `unmatched_remote_assets`, `naming_checked`, `naming_violations`, `category_mismatches`, `folders` and `index_path`, which is the same content as the file it wrote. `jubian_find` returns the `scope` and `name` it searched, `total`, `scanned_pages`, `complete`, `returned`, `truncated` and `scan_page_limit` beside `matches`, whose rows carry `script_id`, `script_name`, `manuscript_name`, `episode_count`, `status` and `script_style` — the provider's own style code, which is what tells 真人 from 漫剧 — plus `can_claim`, `claim_leader_name` and `claim_member_name` under `scope: pool`, where `script_style` is omitted because the pool rows were not measured as carrying it. `prepare_video` returns the whole preview plus its `preview_path`, and `submit_video` returns the claim verdict (`submitted`, `subject_identity_lost`, `reconcile_conflict` or `reconcile_required`) with the claimed `task_id` and a `next` line naming the only safe action. `jubian_model` returns frozen before/after settings and a fingerprint for preview, or per-target `applied`, `stale`, `unknown`, `readback_mismatch` and `not_attempted` outcomes for apply/replay. Each tool result stays in the conversation once it is produced. `image_generate_batch` returns `total`, `returned`, `errors` and ordered `results`. Each result has its own key, target identity and ledger outcome; `status: returned` means only that the request returned, while `asset_status: active` confirms the generated image is available.

#### Token effect

Retained for the rest of the session. One paged asset or subtask list can be large, so `page_size` and `delivery_resolution` are the model's own levers on result size, and `jubian_media` deliberately returns a path instead of the media itself.

#### KV Cache effect

Append-only: a new tool result is appended after the reusable request prefix and does not invalidate existing KV-cache entries.

### Failures

#### What the model sees

A failed call becomes an error tool result carrying one of the six stable codes — `AUTHENTICATION_REQUIRED`, `PERMISSION_DENIED`, `RATE_LIMITED`, `CONTRACT_CHANGED`, `INVALID_ARGUMENT` or `NETWORK_ERROR` — as a `JubianError`. `INVALID_ARGUMENT` separates the caller's own mistake from the provider's behaviour: it is raised before dispatch, names the missing argument, and means no request was sent and no ledger line was written. Envelope-level and reader-level surprises use `CONTRACT_CHANGED`, so that code alone does not say whether a request was sent; the ledger does. Preconditions the caller cannot see in advance, such as a `content_duration_ms` that disagrees with the saved storyboard, also use `CONTRACT_CHANGED`. The provider's own response text and the token never appear in the result.

#### Token effect

Only the retained error result adds tokens; nothing was sent for a failure raised before the request.

#### KV Cache effect

Append-only; the error follows the reusable request prefix and does not invalidate existing KV-cache entries.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>


These limits mark where the package is deliberately incomplete or needs the caller's cooperation. They are current constraints, not a task backlog.

- **Model settings are not a remote transaction** — plan claims are serialized across ledger instances sharing one resolved root in this runtime, not across processes. Immediate rereads detect prior edits, but the provider offers no conditional PUT to exclude a write racing after that read. Errors stop the batch without rollback; preserve the ledger and reconcile before creating another plan. Project/episode lists exceeding 40 pages fail rather than apply a partial scope.
- **The local project cap is not human-owned approval** — the ledger refuses a paid call without a fitting manual or drama-settings ceiling and serializes same-runtime reservations, but an agent with filesystem write access can edit those documents and separate processes do not share a lock. A teammate deployment needs independently enforced owner policy before it permits paid calls. Free library writes such as `rename`, `create_folder` and `move` still change what a person reads in the console; their description asks for consent but the row does not enforce it.
- **A category cannot be corrected without regenerating the asset** — the library writes rename and move an asset; none of them changes its `assetType`. An asset created under the wrong category keeps that category, and the index reports it under `category_mismatches` rather than offering a fix.
- **The workspace build does not regenerate the bundle the loader imports** — `pnpm run build:lib:host` emits this package's TypeScript into `lib/types/`, but a deployment that loads the package from a working copy keeps running the previous `lib/index.js` until `pnpm exec tsdown --config packages/jubian/tool-jubian/tsdown.config.ts` rewrites it and the host restarts. Restarting alone changes nothing, and TypeScript-only edits look applied while the running host still executes the old bundle.
- **`move` and `rename` take a material id, not a parent asset id** — the console's own rename and move are `PUT /aigc/material/reName` and `PUT /aigc/material/move`, whose `id`/`ids` are the material row's identifier, the `material_id` `jubian_asset` `materials` returns. Passing a parent `asset_id` there reaches the provider as an unknown row, which comes back as one of the stable failure codes rather than as a distinguishable "no such material".
- **The organization index reads the personal library's folders only** — the tree read runs with `assetScopeType=2`, the scope the console opens on. Folders created in the team library are not in the index; `create_folder` and `move` still take an explicit `asset_scope_type` and work in either.
- **A manifest row with an unrecognized `type` fails the whole index** — the manifest is the episode map, so one unreadable row stops the call rather than producing an index that silently omits an asset. The failure names the entry, the field it read and the spellings it accepts, which keeps a clean file from being reported as a row missing `name` or `type`.
- **A rejected read reports the envelope, not the field** — a payload the readers in `@deepseek-ai/dsh-jubian-api` cannot map, like any tolerated envelope layout that still holds an unreadable payload, fails as `CONTRACT_CHANGED`. The transport's own rejection carries a redacted description of the body; a reader's rejection does not, so the way to see what the remote actually sent is the `DSH_JUBIAN_DEBUG_DUMP` file: it records one redacted JSONL line per response, with the envelope layout, status, hash and payload of each call. See [the transport's own page](../jubian/README.md#dumping-responses-on-purpose).
- **The paid image route buys from a row the deployment pins** — the account catalogue can list `gpt-image-2` once per platform at its own price, and the plugin has no rule for choosing between them: with several rows and no pinned row, the call fails while the body is compiled and names every candidate. That is deliberate — a default would spend real money on a platform nobody selected — but it means a new account with a second `gpt-image-2` row turns `image_generate` into a configuration error until somebody pins a row, either on the 短剧 settings page or, in a deployment without that page, in this row's `imagePlatformId`/`imageStandardId`.
- **The picker's rows are live account state, and the stored pin is not** — `jubianImage.routes()` reads the catalogue on every call, while the `drama` section stores whatever row id was chosen. A row that disappears from the catalogue is still stored, and the next paid call fails naming the survivors rather than falling back to one; that is the same failure a wrong pin would produce, and it is the only honest one.
- **A timed-out image readback is an answer, not a failure** — `image_generate` reports `asset_status: timeout` rather than throwing, because the paid write was already accepted and the ledger already records it. The caller still has to re-read the asset; the package cannot know whether a slow provider or a failed generation is behind the deadline.
- **`upload_reference` needs a local `ffmpeg` for a non-conforming image** — the provider's image pipeline requires both edges to be multiples of 16, Node ships no image codec, and this package adds no runtime dependency, so an already-aligned file is uploaded byte for byte while any other file is re-encoded by an external `ffmpeg` resolved from `DSH_JUBIAN_FFMPEG`, `FFMPEG_PATH`, `MUSE_FFMPEG_EXECUTABLE` or `PATH`, in that order. With no `ffmpeg` available the call returns `alignment_required` with the exact target size and uploads nothing at all; it never sends a non-conforming file.
- **A prepared preview is bound to this package's serializer** — the fingerprint hashes this plugin's canonical JSON, so a preview written by the pipeline's Python client and one written here are not interchangeable; each is refused as stale by the other.
- **`retry` is gated but not charged-aware** — it reads the parent task and its children before sending anything and refuses a task that has a result file, an active or succeeded child, or a recorded real cost. It cannot see a charge the provider has not written onto the task yet, so a retry after a fresh failure is still the caller's judgement.
- **The endpoint set is transcribed from captured traffic** — every path, query parameter, and request shape lives in `dsh-jubian-api` as captured evidence, not as a published contract. A provider change surfaces as `CONTRACT_CHANGED` or as a field that reads back `null`; verifying a new path needs a fresh capture, so no method here can be treated as schema-versioned. The object-storage signature is the one exception: it is reproduced from the SDK inside the live bundle and verified against the real bucket.
- **An ambiguous outcome is resolved by the ledger, not by the package** — after a timeout the row records `outcome: unknown` and throws. Only the caller can decide whether to re-read with the same key, and nothing reconciles an intent line without a settle line automatically. `submit_video` is the strictest case: it records the ambiguous `PUT`, returns reconciliation guidance, and will not send a second `PUT` for that key under any circumstance.
- **`jubian_media` writes to a local path chosen by the caller** — `output_path` is resolved and created as needed, and an existing file at that path is overwritten without a prompt. Its origin allowlist deliberately excludes the alternate mirror origin that some payload fields return.
- **The provider's `taskExecute` and `terminate` endpoints are not implemented** — the pipeline's own client never calls them, so adding them here would be transcription without evidence. `terminate` remains the obvious gap if a runaway task ever needs stopping.
- **No system-prompt section is registered** — a deployment cannot adjust the model's guidance for these tools without changing the package, and a provider that renames a method leaves the descriptions stale until the package is edited.

Video submission accepts an agent-calculated `estimated_cost_cny` and `estimate_basis` per preview, based on the project model’s current catalogue price and usage or comparable settled costs. Estimates reserve budget and are not settled bills. Batch submission reserves the sum before any PUT. Missing duration capability does not authorize replacing the project model.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

This Dev Note is working context for maintainers: open questions and undecided directions. It is explicitly non-authoritative — shipped behavior, limits, and rationale live in the sections above.

#### Future: a pre-flight cost estimate for paid writes

`jubian_catalog` `rate` already reads one pricing standard, and `image_generate` snapshots the displayed unit price into its intent line, but no method returns a full estimate for a batch before it is submitted, and the descriptions name no such step. A caller that wants one composes it from catalogue reads today.

#### Future: a reconciliation read over the ledger

Nothing reads the ledger back. A command that lists intent lines without a settle line would answer "what is still unknown" without a hand-written scan of `<ledgerRoot>/YYYY-MM-DD.ndjson`, but no such surface exists yet.

</details>
