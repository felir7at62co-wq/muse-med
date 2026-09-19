---
description: "The five Jubian (剧变) tools a DSH model calls to drive a production: catalogue, asset and storyboard writes, local reference upload, the storyboard-native video channel, paid image/video generation and erasure, and provider media download."
kind: "package-reference"
---

# @deepseek-ai/dsh-tool-jubian

English | [中文](README.zh.md)

## Summary

`dsh-tool-jubian` gives a DSH model five tools that drive a Jubian production end to end: catalogue reads, asset and storyboard edits, a local reference-image upload, the storyboard-native subject-video channel, paid image and video generation, subtitle erasure, upscaling, and media download. Reads are free; every paid or state-changing call needs a caller-supplied `idempotency_key`, and the plugin records an intent line before the request leaves and a settle line after the response returns. A replayed key sends nothing and returns the recorded outcome. The ledger is the only evidence of what a timeout already charged.

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

Mount the row in any preset that needs to read or change a Jubian production, then give the model a task; the five tools appear with their costs written into their descriptions.

### When to choose it

Choose this package when an agent must inspect a project, upload a local reference image, save a subject selection, prepare and submit subject-backed video, confirm casting, generate images, generate or erase video, upscale a finished clip to 1080p, or pull provider media down for its own vision tools. Mount it wherever the credential resolves, because the same row serves a read-only survey and a paid generation run. Skip it when nothing in the session talks to Jubian: the five schemas and their descriptions stay visible to the model whether or not they are used.

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
```

| Field | Default | Meaning |
|---|---|---|
| `ledgerRoot` | `<DSH_HOME>/jubian/ledger` | Directory holding the write ledger; one NDJSON file per day |
| `baseUrl` | the transport's own default origin | Origin override for every request |
| `timeoutMs` | the transport's own default | Per-call abort budget in milliseconds |
| `workspaceSecrets` | `true` | Whether the workspace pipeline secret file may stand in for a missing credential-store value |
| `imagePlatformId` | none | Which `platformId` of the `taskType=2` catalogue `image_generate` buys from, such as `KU_AI` |
| `imageStandardId` | none | Which catalogue row (`standardId`, the row's own `id`) `image_generate` buys from; either this or `imagePlatformId` pins one row |
| `imageActiveTimeoutMs` | `180000` | How long `image_generate` waits for the new asset to reach `hsAssetStatus` `Active` before reporting a timeout |
| `imageActivePollMs` | `3000` | Delay between the readback polls above |

An account catalogue can list one model id once per platform at different prices; `image_generate` never picks one of those rows for you, so a catalogue with several `gpt-image-2` rows and neither field set fails while the request body is compiled and lists every candidate with its `platformId`, `standardId`, unit price and unit.

The generated [configuration catalog](../../../docs/config-catalog.md#deepseek-aidsh-tool-jubian) is the exhaustive source for every accepted field and its JSDoc. The row injects `tools` and `credentials`, and registers all five tools at mount; there is no per-tool enable flag.

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

### The five tools

The five registered tools are the whole model-facing surface. This package publishes no system-prompt section, so every operational fact the model needs travels in a tool description or a schema description.

| Tool | Methods | Billing and effect |
|---|---|---|
| `jubian_catalog` | `models`, `rate`, `script`, `episodes` | Read-only, no charge |
| `jubian_asset` | `get`, `list`, `materials`, `generated_image` | Read-only, no charge |
| | `confirm_casting` | Changes provider state through a `GET`; needs `idempotency_key` |
| | `remove` | Deletes one parent asset irrecoverably; needs `idempotency_key` |
| | `upload_reference` | Free and task-free; writes one object into the provider's bucket |
| `jubian_storyboard` | `get`, `create`, `save` | Writes, but free; `save` forces `isGenerate=0` |
| | `select_assets` | Free and forced to `isGenerate=0`; needs `idempotency_key` |
| | `prepare_video` | Free and read-only remotely; writes one local preview file |
| | `generate`, `submit_video`, `erase_subtitle` | Billable and irreversible; need `idempotency_key` |
| `jubian_video` | `task`, `tasks`, `subtasks` | Read-only, no charge |
| | `image_generate`, `upscale` | Billable and irreversible; need `idempotency_key` |
| | `retry` | Changes provider task state; needs `idempotency_key` |
| `jubian_media` | `download` | Free and credential-free; writes one local file |

- `jubian_catalog` reads the account model catalogue for a task type (`task_type` 1 video, 2 image, 10 subtitle erasure), one pricing standard by `standard_id`, a screenplay identity by `script_id`, and its paged episodes.
- `jubian_asset` reads one asset, a paged project asset list, the confirmed casting materials, or the generated image URL of an asset. `confirm_casting` takes the generated material id — not the parent asset and not a task id — and adopts that material for this production. `remove` issues `DELETE /aigc/asset/removeAsset/{assetId}?scriptId=<id>&isParent=1`: the parent asset and its media versions are removed, the shot matches that referenced it are not rebuilt, and already generated video is not regenerated. Cancelling a casting decision is a different operation; `remove` is not it. `upload_reference` takes a local `image_path`, verifies both edges are multiples of 16 (the rule the provider's own image pipeline needs), uploads to the destination the live frontend bundle configures, and returns the `materialUrl`/`materialType`/`sortOrder` item an asset request or `image_generate` `references` list needs. It charges nothing and creates no task, but it does write an object into the provider's bucket.
- `jubian_storyboard` reads one storyboard, creates one from a complete request body the caller supplies, saves without generating, submits generation, or erases burned-in subtitles. `generate` reads the current storyboard snapshot, sets `isGenerate=1`, and writes it back, so it also requires `content_duration_ms` equal to the duration already saved on that storyboard; a mismatch fails before any request leaves. `erase_subtitle` needs the task id, the video frame size and an explicit `model_id`: `quzimuToB` (regional — the erase rectangle defaults to the provider's own proportion of the frame, so `subtitle_box` is optional and normally omitted) or `ark-erase-video-subtitle-pro` (automatic, rejects `subtitle_box`). It has no default model, so a caller that omits `model_id` is told which argument is missing instead of having a model chosen for it. The project, episode and source identities are read from the task and its child results, so `script_id` is not required. The three storyboard-native methods are described in the section below, "The storyboard-native video channel".
- `jubian_video` reads one task (including its observed cost), a project's paged video tasks, or a task's sub-results, which carry the finished `video_url`, the subtitle pixel box, the stage history, the resolution of each result and the `needs_upscale` verdict. `subtasks` carries its query in a `POST` body and still only reads. `image_generate` builds a billable asset image: `asset_name`, `asset_type`, `prompt` and optional ordered `references` are required, and a supplied `parent_asset_id` regenerates that asset through `PUT` instead of creating a new one through `POST`. The write is asynchronous, so the method then reads the new asset back until `hsAssetStatus` is `Active` and returns its `material_id` — the id `confirm_casting` takes — with its `image_url`; see "The paid image route" below. `upscale` submits one billable 1080p conversion (SeedVR2 video upscale, 1 CNY per clip) and takes `task_id` plus `idempotency_key`; every other identity is read from the parent task and its first child result. `retry` re-executes one terminal, uncharged failure; it reads the parent task and its children first and refuses to send anything unless the parent is terminally failed, no child holds a file or an active/succeeded state, and the task carries no real cost.
- `jubian_media` downloads one provider medium to `output_path` and returns the path, detected media type, byte count and sha256. It never puts the bytes into the result: tens of megabytes of base64 would poison every later request.

### The storyboard-native video channel

A subject-backed video is created by the provider from a storyboard `PUT` with `isGenerate=1`; a direct task `POST` does not preserve subject identity. Production evidence isolates that difference: task `335343` came from the storyboard `PUT`, retained all seven identities, and succeeded, while `335470` came from direct `POST /admin/aigc/video/task/create`, lost `assetId`/`materialName`, and failed. That route is therefore unsupported here, and there is no method that calls it.

The only normal order is three calls:

```text
select_assets  (isGenerate=0, free)  -> prepare_video (free, local preview) -> submit_video (one PUT, paid)
```

- `select_assets` saves an ordered subject selection. Each `material_key` must appear in the prompt's own `@[name](key)` order, every selection must resolve to exactly one active subject-setting row and one parent asset in the same project, and the row's trusted `hsAssetId` is what the provider will translate into the child task's identity. The body is always forced to `isGenerate=0`. After the single `PUT` the row re-reads the storyboard as well as the project's task list: a saved order that disagrees with the plan is an error, and a video task that appeared across a selection-only save is reported as `billing_safety_violation` so a caller stops rather than continues.
- `prepare_video` is free and read-only on the provider. It checks `project_config.json` in `project_dir` against the live `scriptId`, hydrates every ordered material from the live storyboard, the subject picker and the parent assets, requires `9:16`/`720p`/`genNum=1` and an integer content duration of 1–14 seconds, resolves the live non-Mini Seedance 2.0 model with a `9:16`/`720p`/`genNum=1` standard, and writes one preview into `<project_dir>/video_tasks/storyboard-<id>-<key12>.storyboard-native.prepared.json` through a temporary file and a rename. It sends no `PUT`, creates no task, and charges nothing.
- `submit_video` takes that `preview_path` and an `idempotency_key` that **must equal the preview's own fingerprint**. A mismatch, a stale preview (the live semantics changed since it was written) or a preview that is not this plugin's own fails before anything is sent. Otherwise it takes a complete, paged task snapshot, refuses to continue if a second read of that snapshot drifts, sends at most one `PUT /aigc/storyboard` with `isGenerate=1`, and takes a second snapshot to claim the one new task whose ordered `assetId`/`materialName`/`imageUrl` and model/prompt evidence match the preview exactly.

The verdicts are the contract. `submitted` means one task was claimed with its identity intact; `subject_identity_lost` is terminal — the child kept URLs but lost an identity field, and the answer is inspection, never a second `PUT`; `reconcile_conflict` means more than one candidate or incomplete evidence, which is also never a retry signal; `reconcile_required` means the one `PUT` happened but no task is visible yet, and re-calling with the same preview and key only re-reads. A `PUT` that fails for any reason — timeout, `5xx`, connection loss — is recorded with `outcome: unknown` and `put_ambiguous: true`: no automatic retry exists, and the same key can never send a second `PUT`.

Because the key is the preview's fingerprint, the same preview file can cause exactly one request in its lifetime. A preview is therefore **not** interchangeable with the CLI's own prepared file: the two serializers hash different JSON text, so a preview written by one is refused as stale by the other.

### The paid image route

`image_generate` is one paid write followed by a free readback, and which catalogue row it writes against is a deployment decision rather than a guess:

```text
pin the gpt-image-2 row (imagePlatformId / imageStandardId)
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

Every write method requires a non-empty `idempotency_key`, and no method ever generates one; a generated key would let a retry after an ambiguous outcome bypass the record of the first attempt.

Repeating a key sends no request at all, returns the recorded outcome, and sets `replayed: true`. The guarantee holds structurally rather than by convention: a write body is compiled lazily, so a replayed call does not even perform the provider reads that the body needs.

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

Erasure and upscaling are asynchronous provider tasks. `erase_subtitle` and `upscale` return as soon as the provider accepts the task, with the accepted task id; a measured upscale run took minutes to more than ten of them.

```text
submit -> receive the accepted task id -> do other work -> re-read subtasks
```

Do not block on the submission. Re-read `jubian_video` `subtasks` later and judge completion from that task's `hd_count`, `last_task_type` and `resolution` rather than from the original response. Pass `delivery_resolution` (for example `1080p`) on the readback so every row gets a `needs_upscale` verdict: `true` means that result is below the target and cannot be delivered as it stands; `null` means the labels did not allow a judgement. Changing an extension or transcoding locally does not substitute for the provider stage.

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
- **Paid authorization stays with the caller.** The row performs no budget check and no spend confirmation. It guarantees one thing: a replayed key does not become a second charge. Whether to spend at all is the deployment's and the caller's decision.
- **The transport owns the wire, the ledger owns the money question.** Credential resolution, envelope normalization, error classification, redirects and byte caps live in `dsh-jubian`. The two-phase ledger and the lazily compiled bodies live here, because this is the layer that knows which methods write.

### Source map

| File | Role |
|---|---|
| [`src/index.ts`](src/index.ts) | Plugin entry: the `Config` interface, the ledger and client construction, the credential fallback, the five `ctx.tools.register` calls, and the shared argument and output contracts |
| [`src/methods.ts`](src/methods.ts) | One async function per tool: method dispatch, request shaping, and the local media write |
| [`src/write.ts`](src/write.ts) | The two-phase `writeUnderLedger` helper, the request-body hash and the required-key check every write path shares |
| [`src/native.ts`](src/native.ts) | The storyboard-native flow: the paged dual snapshot, the single `PUT`, task claiming and the atomic preview write |
| [`src/reference.ts`](src/reference.ts) | The local reference upload: file reading, the optional `ffmpeg` re-encode, the frontend bundle read and the signed object `PUT` |
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

- [Generated tool catalog](../../../docs/tool-catalog.md#deepseek-aidsh-tool-jubian) — the exact schema and description of all five tools.
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

The model sees the schemas and descriptions of `jubian_catalog`, `jubian_asset`, `jubian_storyboard`, `jubian_video` and `jubian_media` as generated in the [tool catalog](../../../docs/tool-catalog.md#deepseek-aidsh-tool-jubian). Each schema is one open JSON object with a required `method` enum and the arguments that method accepts; parameter and enum descriptions are plain Chinese text, because they address the model rather than a localized UI. Numeric codes appear where the provider defines them — `task_type` (`1` video, `2` image, `10` subtitle erasure), `asset_type`, and `subtasks` `hd_count` / `last_task_type` / `resolution`.

#### Token effect

Fixed per request while the row is mounted: five tool definitions with their enum and argument descriptions, and no prompt section. Enabling or removing the row is the only lever on this cost.

#### KV Cache effect

Prefix-stable while the mounted tool set and the package version are unchanged; a package upgrade, a mount change, or a serialization change to any description may invalidate reuse from the first changed definition token.

### Idempotency contract in the descriptions

#### What the model sees

Every write method's description states that `idempotency_key` is required, that a repeated key returns the existing record with `replayed: true` instead of sending anything, and that a timeout or unknown result means re-calling with the same key rather than a new one. The read methods accept no key.

#### Token effect

A fixed addition to each write method's description, repeated in the shared `idempotency_key` argument description; no prompt tokens.

#### KV Cache effect

Prefix-stable while the description text is unchanged. Editing these sentences is a package change, so it invalidates reuse from the first changed tool definition.

### Cost and side-effect warnings in the descriptions

#### What the model sees

The descriptions name `jubian_video` `image_generate` and `upscale`, `jubian_storyboard` `generate`, `submit_video` and `erase_subtitle`, and `jubian_asset` `remove` as billable or irreversible, and state that `confirm_casting` changes provider state through a `GET` even though the verb suggests a read. `jubian_video` `subtasks` states that its `POST` only reads. `jubian_video` `image_generate` additionally states that it reads the asset back to `Active` before returning, what each `asset_status` value means, and that a catalogue listing several `gpt-image-2` rows fails without a configured `imagePlatformId`/`imageStandardId`. `jubian_storyboard` states the whole storyboard-native order, that `select_assets` is forced to `isGenerate=0`, that `prepare_video` neither `PUT`s nor charges, and that the direct task `POST` is forbidden. The async methods state that they return on acceptance and that completion is read back later from `subtasks`.

#### Token effect

Fixed description text per tool; the paid tools carry the longest descriptions in the package. No prompt tokens and no result tokens until the model calls them.

#### KV Cache effect

Prefix-stable while the mounted set and these descriptions are unchanged; a package change that rewrites them invalidates reuse from the first changed definition.

### Tool results

#### What the model sees

Every call returns one pretty-printed JSON object under a shared open-object output schema, keyed by the method that asked for it (`asset`, `assets`, `storyboard`, `subtasks`, `task`, and so on) plus the model's guidance fields. Write results carry `replayed`, `outcome`, `response_sha256` and the envelope data; `erase_subtitle` and `upscale` add `accepted_task_id` and a `next` line telling the model not to wait. `image_generate` returns `parent_asset_id`, `model_selection`, `asset_status`, `material_id`, `image_url`, `observed_asset_status`, `waited_ms`, `readback_error` and a `next` line, so a model reads the image's identity from the result instead of assuming acceptance produced one. `prepare_video` returns the whole preview plus its `preview_path`, and `submit_video` returns the claim verdict (`submitted`, `subject_identity_lost`, `reconcile_conflict` or `reconcile_required`) with the claimed `task_id` and a `next` line naming the only safe action. Each tool result stays in the conversation once it is produced.

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

- **There is no spend cap, budget check, or paid-write confirmation** — the row submits any well-formed write the caller asks for. Idempotency prevents a duplicate charge for one key; it does not prevent a first charge. A deployment that needs a ceiling or a human confirmation must add a `tools/pre-execute` policy of its own.
- **The paid image route buys from a row the deployment pins** — the account catalogue can list `gpt-image-2` once per platform at its own price, and the plugin has no rule for choosing between them: with several rows and neither `imagePlatformId` nor `imageStandardId` configured, the call fails while the body is compiled and names every candidate. That is deliberate — a default would spend real money on a platform nobody selected — but it means a new account with a second `gpt-image-2` row turns `image_generate` into a configuration error until the row is pinned.
- **A timed-out image readback is an answer, not a failure** — `image_generate` reports `asset_status: timeout` rather than throwing, because the paid write was already accepted and the ledger already records it. The caller still has to re-read the asset; the package cannot know whether a slow provider or a failed generation is behind the deadline.
- **`upload_reference` needs a local `ffmpeg` for a non-conforming image** — the provider's image pipeline requires both edges to be multiples of 16, Node ships no image codec, and this package adds no runtime dependency, so an already-aligned file is uploaded byte for byte while any other file is re-encoded by an external `ffmpeg` resolved from `DSH_JUBIAN_FFMPEG`, `FFMPEG_PATH`, `MUSE_FFMPEG_EXECUTABLE` or `PATH`, in that order. With no `ffmpeg` available the call returns `alignment_required` with the exact target size and uploads nothing at all; it never sends a non-conforming file.
- **A prepared preview is bound to this package's serializer** — the fingerprint hashes this plugin's canonical JSON, so a preview written by the pipeline's Python client and one written here are not interchangeable; each is refused as stale by the other.
- **`retry` is gated but not charged-aware** — it reads the parent task and its children before sending anything and refuses a task that has a result file, an active or succeeded child, or a recorded real cost. It cannot see a charge the provider has not written onto the task yet, so a retry after a fresh failure is still the caller's judgement.
- **The endpoint set is transcribed from captured traffic** — every path, query parameter, and request shape lives in `dsh-jubian-api` as captured evidence, not as a published contract. A provider change surfaces as `CONTRACT_CHANGED` or as a field that reads back `null`; verifying a new path needs a fresh capture, so no method here can be treated as schema-versioned. The object-storage signature is the one exception: it is reproduced from the SDK inside the live bundle and verified against the real bucket.
- **An ambiguous outcome is resolved by the ledger, not by the package** — after a timeout the row records `outcome: unknown` and throws. Only the caller can decide whether to re-read with the same key, and nothing reconciles an intent line without a settle line automatically. `submit_video` is the strictest case: it records the ambiguous `PUT`, returns reconciliation guidance, and will not send a second `PUT` for that key under any circumstance.
- **`jubian_media` writes to a local path chosen by the caller** — `output_path` is resolved and created as needed, and an existing file at that path is overwritten without a prompt. Its origin allowlist deliberately excludes the alternate mirror origin that some payload fields return.
- **The provider's `taskExecute` and `terminate` endpoints are not implemented** — the pipeline's own client never calls them, so adding them here would be transcription without evidence. `terminate` remains the obvious gap if a runaway task ever needs stopping.
- **No system-prompt section is registered** — a deployment cannot adjust the model's guidance for these tools without changing the package, and a provider that renames a method leaves the descriptions stale until the package is edited.

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
