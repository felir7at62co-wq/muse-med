---
description: "The five Jubian (剧变) tools a DSH model calls to drive a production: catalogue, asset and storyboard writes, paid image/video generation and erasure, and provider media download."
kind: "package-reference"
---

# @deepseek-ai/dsh-tool-jubian

English | [中文](README.zh.md)

## Summary

`dsh-tool-jubian` gives a DSH model five tools that drive a Jubian production end to end: catalogue reads, asset and storyboard edits, paid image and video generation, subtitle erasure, upscaling, and media download. Reads are free; every paid or state-changing call needs a caller-supplied `idempotency_key`, and the plugin records an intent line before the request leaves and a settle line after the response returns. A replayed key sends nothing and returns the recorded outcome. The ledger is the only evidence of what a timeout already charged.

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

Choose this package when an agent must inspect a project, confirm casting, generate images, generate or erase video, upscale a finished clip to 1080p, or pull provider media down for its own vision tools. Mount it wherever the credential resolves, because the same row serves a read-only survey and a paid generation run. Skip it when nothing in the session talks to Jubian: the five schemas and their descriptions stay visible to the model whether or not they are used.

### Minimal configuration

```yaml
- insert:
    - id: tool-jubian
      name: '@deepseek-ai/dsh-tool-jubian'
      # config is optional:
      # ledgerRoot: D:\somewhere\jubian-ledger   # default <DSH_HOME>/jubian/ledger
      # baseUrl: https://web.jubianai.net/prod-api
      # timeoutMs: 30000
```

| Field | Default | Meaning |
|---|---|---|
| `ledgerRoot` | `<DSH_HOME>/jubian/ledger` | Directory holding the write ledger; one NDJSON file per day |
| `baseUrl` | the transport's own default origin | Origin override for every request |
| `timeoutMs` | the transport's own default | Per-call abort budget in milliseconds |

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

### The five tools

The five registered tools are the whole model-facing surface. This package publishes no system-prompt section, so every operational fact the model needs travels in a tool description or a schema description.

| Tool | Methods | Billing and effect |
|---|---|---|
| `jubian_catalog` | `models`, `rate`, `script`, `episodes` | Read-only, no charge |
| `jubian_asset` | `get`, `list`, `materials`, `generated_image` | Read-only, no charge |
| | `confirm_casting` | Changes provider state through a `GET`; needs `idempotency_key` |
| | `remove` | Deletes one parent asset irrecoverably; needs `idempotency_key` |
| `jubian_storyboard` | `get`, `create`, `save` | Writes, but free; `save` forces `isGenerate=0` |
| | `generate`, `erase_subtitle` | Billable and irreversible; need `idempotency_key` |
| `jubian_video` | `task`, `tasks`, `subtasks` | Read-only, no charge |
| | `image_generate`, `upscale` | Billable and irreversible; need `idempotency_key` |
| `jubian_media` | `download` | Free and credential-free; writes one local file |

- `jubian_catalog` reads the account model catalogue for a task type (`task_type` 1 video, 2 image, 10 subtitle erasure), one pricing standard by `standard_id`, a screenplay identity by `script_id`, and its paged episodes.
- `jubian_asset` reads one asset, a paged project asset list, the confirmed casting materials, or the generated image URL of an asset. `confirm_casting` takes the generated material id — not the parent asset and not a task id — and adopts that material for this production. `remove` issues `DELETE /aigc/asset/removeAsset/{assetId}?scriptId=<id>&isParent=1`: the parent asset and its media versions are removed, the shot matches that referenced it are not rebuilt, and already generated video is not regenerated. Cancelling a casting decision is a different operation; `remove` is not it.
- `jubian_storyboard` reads one storyboard, creates one from a complete request body the caller supplies, saves without generating, submits generation, or erases burned-in subtitles. `generate` reads the current storyboard snapshot, sets `isGenerate=1`, and writes it back, so it also requires `content_duration_ms` equal to the duration already saved on that storyboard; a mismatch fails before any request leaves. `erase_subtitle` needs the video frame size, and takes the optional `model_id` `quzimuToB` (regional, requires `subtitle_box`) or `ark-erase-video-subtitle-pro` (automatic, rejects `subtitle_box`); other source identities are read from the provider.
- `jubian_video` reads one task (including its observed cost), a project's paged video tasks, or a task's sub-results, which carry the finished `video_url`, the subtitle pixel box, the stage history, the resolution of each result and the `needs_upscale` verdict. `subtasks` carries its query in a `POST` body and still only reads. `image_generate` builds a billable asset image: `asset_name`, `asset_type`, `prompt` and optional ordered `references` are required, and a supplied `parent_asset_id` regenerates that asset through `PUT` instead of creating a new one through `POST`. `upscale` submits one billable 1080p conversion (SeedVR2 video upscale, 1 CNY per clip) and takes `task_id` plus `idempotency_key`; every other identity is read from the parent task and its first child result.
- `jubian_media` downloads one provider medium to `output_path` and returns the path, detected media type, byte count and sha256. It never puts the bytes into the result: tens of megabytes of base64 would poison every later request.

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
| `NETWORK_ERROR` | Connection failure, timeout, refused redirect, or any other non-2xx status |

### Submitting an asynchronous stage

Erasure and upscaling are asynchronous provider tasks. `erase_subtitle` and `upscale` return as soon as the provider accepts the task, with the accepted task id; a measured upscale run took minutes to more than ten of them.

```text
submit -> receive the accepted task id -> do other work -> re-read subtasks
```

Do not block on the submission. Re-read `jubian_video` `subtasks` later and judge completion from that task's `hd_count`, `last_task_type` and `resolution` rather than from the original response. Pass `delivery_resolution` (for example `1080p`) on the readback so every row gets a `needs_upscale` verdict: `true` means that result is below the target and cannot be delivered as it stands; `null` means the labels did not allow a judgement. Changing an extension or transcoding locally does not substitute for the provider stage.

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
| [`src/index.ts`](src/index.ts) | Plugin entry: the `Config` interface, the ledger and client construction, the five `ctx.tools.register` calls, and the shared argument and output contracts |
| [`src/methods.ts`](src/methods.ts) | One async function per tool: method dispatch, request shaping, the two-phase `writeUnderLedger` helper, and the local media write |
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

The descriptions name `jubian_video` `image_generate` and `upscale`, `jubian_storyboard` `generate` and `erase_subtitle`, and `jubian_asset` `remove` as billable or irreversible, and state that `confirm_casting` changes provider state through a `GET` even though the verb suggests a read. `jubian_video` `subtasks` states that its `POST` only reads. The async methods state that they return on acceptance and that completion is read back later from `subtasks`.

#### Token effect

Fixed description text per tool; the paid tools carry the longest descriptions in the package. No prompt tokens and no result tokens until the model calls them.

#### KV Cache effect

Prefix-stable while the mounted set and these descriptions are unchanged; a package change that rewrites them invalidates reuse from the first changed definition.

### Tool results

#### What the model sees

Every call returns one pretty-printed JSON object under a shared open-object output schema, keyed by the method that asked for it (`asset`, `assets`, `storyboard`, `subtasks`, `task`, and so on) plus the model's guidance fields. Write results carry `replayed`, `outcome`, `response_sha256` and the envelope data; `erase_subtitle` and `upscale` add `accepted_task_id` and a `next` line telling the model not to wait. Each tool result stays in the conversation once it is produced.

#### Token effect

Retained for the rest of the session. One paged asset or subtask list can be large, so `page_size` and `delivery_resolution` are the model's own levers on result size, and `jubian_media` deliberately returns a path instead of the media itself.

#### KV Cache effect

Append-only: a new tool result is appended after the reusable request prefix and does not invalidate existing KV-cache entries.

### Failures

#### What the model sees

A failed call becomes an error tool result carrying one of the five stable codes — `AUTHENTICATION_REQUIRED`, `PERMISSION_DENIED`, `RATE_LIMITED`, `CONTRACT_CHANGED` or `NETWORK_ERROR` — as a `JubianError`. Argument and precondition failures raised before the request, such as a missing `idempotency_key` or a `content_duration_ms` that disagrees with the saved storyboard, use `CONTRACT_CHANGED` as well, so the code alone does not say whether a request was sent; the ledger does. The provider's own response text and the token never appear in the result.

#### Token effect

Only the retained error result adds tokens; nothing was sent for a failure raised before the request.

#### KV Cache effect

Append-only; the error follows the reusable request prefix and does not invalidate existing KV-cache entries.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>


These limits mark where the package is deliberately incomplete or needs the caller's cooperation. They are current constraints, not a task backlog.

- **There is no spend cap, budget check, or paid-write confirmation** — the row submits any well-formed write the caller asks for. Idempotency prevents a duplicate charge for one key; it does not prevent a first charge. A deployment that needs a ceiling or a human confirmation must add a `tools/pre-execute` policy of its own.
- **The endpoint set is transcribed from captured traffic** — every path, query parameter, and request shape lives in `dsh-jubian-api` as captured evidence, not as a published contract. A provider change surfaces as `CONTRACT_CHANGED` or as a field that reads back `null`; verifying a new path needs a fresh capture, so no method here can be treated as schema-versioned.
- **An ambiguous outcome is resolved by the ledger, not by the package** — after a timeout the row records `outcome: unknown` and throws. Only the caller can decide whether to re-read with the same key, and nothing reconciles an intent line without a settle line automatically.
- **`jubian_media` writes to a local path chosen by the caller** — `output_path` is resolved and created as needed, and an existing file at that path is overwritten without a prompt. Its origin allowlist deliberately excludes the alternate mirror origin that some payload fields return.
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
