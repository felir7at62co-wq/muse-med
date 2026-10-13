---
description: "The short-drama pipeline's pre-spend asset reconciliation as one model-facing tool: compare the Jubian project's used assets with the manifest, write the evidence the paid-call gate reads, and record a disposition per unregistered asset, for users and maintainers running the Jubian drama pipeline."
kind: "package-reference"
---

# @deepseek-ai/dsh-tool-drama-assets

English | [中文](README.zh.md)

## Summary

Use this package when a short-drama session must know what the Jubian project already contains before it pays for a new asset. One tool, `drama_assets`, reads both sides — the remote project's used-and-active assets and the project's own `assets_manifest.json` — and writes the evidence the host's paid-call gate reads: `_probe/asset-reconcile.json`. `reconcile` makes the comparison; `dispose` records one person's decision about one asset it found. The manifest records what this pipeline generated, not what the project has, so a model reading only the manifest regenerates an asset that already exists.

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

Mount the plugin as one row of a short-drama preset; it needs the tool registry and the credential store:

```yaml
- id: tool-drama-assets
  name: '@deepseek-ai/dsh-tool-drama-assets'
  config:
    timeoutMs: 30000        # per-read abort budget
    workspaceSecrets: true  # let .agents/secrets/pipeline.env stand in for a missing store value
```

| Field | Default | Meaning |
|---|---|---|
| `baseUrl` | the client's own default origin | Origin override for the two remote reads. |
| `timeoutMs` | `30000` | Per-read abort budget in milliseconds, 1–60000. |
| `workspaceSecrets` | `true` | Whether the nearest `.agents/secrets/pipeline.env` may supply the token when the credential store holds none. |
| `matchPageSize` | `1000` | Matching-only page size, 1–1000. |
| `matchPageLimit` | `100` | Positive maximum pages per matching inventory; exhaustion blocks. |
| `matchRequirementLimit` | `100` | Positive maximum requirements per preview. |

The token itself is the credential reference `JUBIANAI_ADMIN_TOKEN`, resolved through `ctx.credentials` on every read, and never written to a result, a log or a preview.

### Methods

| Method | Reads | Writes | Use it for |
|---|---|---|---|
| `reconcile` | The remote project's assets and materials, and the manifest | `<project_dir>/_probe/asset-reconcile.json` | Knowing which used assets the manifest does not record, before any paid generation |
| `dispose` | The evidence file | The same evidence file | Recording one decision — `registered` or `ignored` — about one unregistered asset |
| `reuse_preview` | Matching inputs and optional live storyboard GETs | None | Centralized review and preserved-card binding suggestions without approval or execution |
| `usage_preview` | Current manifests, bible and optional hash-pinned compiler outputs | None | Exact local asset references and missing voices |
| `match_preview` | Source-backed requirements, manifest, project bible, voice records and complete current-project GET inventories | None | Preparing character, scene and approved voice reuse recommendations |

| Parameter | Required | Meaning |
|---|---|---|
| `method` | always | `reconcile`, `dispose`, `match_preview`, `reuse_preview` or `usage_preview` |
| `project_dir` | always | Project root holding `assets_manifest.json`, absolute |
| `asset_id` | `dispose` | The unregistered asset the decision is about |
| `status` | `dispose` | `registered` or `ignored` |
| `note` | `ignored` | Why the asset is not needed; must be non-empty for `ignored` |

`reconcile` sends exactly two requests, both the provider's own list endpoints, and charges nothing. `dispose` sends none. The only file either method writes is the evidence file, atomically replaced with owner-only permissions where supported.

### Audio preparation and current uses

After a successful video download, the consuming preset loads the voice continuity skill proactively. Its packaged `prepare_voice_assets.py` extracts the complete mix and missing-character PCM WAV candidates, preserves current voice profiles, and atomically merges the local voice ledger under an OS-released lock. Task ID, source digest, character ID and interval identify a candidate across reruns and costume changes. Extraction neither uploads nor approves; the complete long mix is not uploaded as a character reference, while a two-second speech sample may retain background sound. Actual listening and the existing upload/register/readback tools own adoption.

`usage_preview` reads current project files without network or file writes. Omit `plan_path` to inspect project voice references and gaps. Supply a version-1 index with `documents` containing `path`, SHA-256 `sha256` and positive `episode` for each saved successful `drama_shot compile` result. The tool checks each package's explicit parent/material IDs, name, category and URL against the current asset manifest, then reports package references and only the shots whose explicit bindings use that asset, with its exact registered version. Optional `asset_id` selects an exact parent. `total` counts matching uses; `truncated` reports omitted rows under `matchRequirementLimit`, which also bounds documents and voice states. The view distinguishes local planned references from remote binding receipts; remote identity, approval and generated quality remain subject to existing readback. New registrations are visible on the next read, without another authoritative cache. Input failures report related issues or refuse the query; they add no project workflow gate.

```json
{"version":1,"documents":[{"path":"episode_packages/54-compile.json","sha256":"<actual-file-sha256>","episode":54}]}
```

### Read-only matching preview

Call `method=match_preview` with `project_dir` and project-contained `requirements_path`. The [input and decision rules](../skills/skills/tweet-drama-core/references/match-preview.md) define version-1 requirements, exact source lines/SHA-256, registered identity links, scene conditions and approved voice samples. The result reports `reuse_ready`, `needs_review`, `missing` or `blocked`, candidate IDs and reasons. Names alone never establish identity. Every supplied stable and character identity must agree with the manifest and project bible; contradictory identities return `IDENTITY_FIELDS_CONFLICT`. Registered costume versions may have different parent IDs when the project reference asset is also registered to that character, official, and present in the current project inventory. Failed reads, incomplete pagination, conflicting project bindings or changed sources block instead of claiming absence.

This method writes no local or remote file and never generates, approves or binds. `missing` covers only the current project; historical retrieval remains owned by the existing asset-library Skill. Registered facts and existing approvals guide reuse, without an image/audio quality verdict. Final adoption remains a human decision and actual binding uses the existing tools. Matching returns no `ready` evidence and does not change reconciliation, paid authorization or the ledger. Inputs are rechecked after provider reads; final binding still requires its own live verification.

### Centralized reuse preview

`reuse_preview` reuses the same matching checks and groups requirements only when identity, state, conditions and candidate selection agree. It returns candidate details, applicability, version/source fingerprints and optional per-card selection suggestions. See the [mapping format](../skills/skills/tweet-drama-core/references/match-preview.md#集中复用与分镜预检). The existing `select_assets` builder validates image identity and prompt order; suggestions preserve every unrelated material at its current position and retain model, prompt and provider fields. Changes that cannot preserve those values block the preview. Character requirements may share a verified `stable_id` when no `character_id` is supplied; the two identity types remain distinct for grouping. Image requirements mapped to audio placeholders block with `IMAGE_MAPPING_TARGETS_AUDIO`. Card preflight stops after the first failure. Repeating a preview causes no application.

The workflow is matching preview → reuse recommendations → user confirmation → model calls the existing `jubian_storyboard.select_assets` tool. `reuse_ready`, `already_bound` and fingerprints are observations, not authorization. `apply_allowed=false` means the preview grants no write permission; it does not prevent a model from using existing binding tools after real user authorization. Per-card IDs and ordered selections come from `shots`; changed source, identity, version or scope requires renewed review. Voice references continue through `audio_preview → audio_apply`. This package adds no binding executor or approval issuer, and existing tools retain their authorization, identity, order, idempotency and readback checks.

### What decides the verdict

| Evidence field | Meaning |
|---|---|
| `source` | Rows each remote read returned, how many assets are alive (`delFlag == "0"`), and how many are used (`isUsed == 1` and `hsAssetStatus == "Active"`) |
| `manifest` | What the manifest declared: `items`, `lead_readonly_records`, and the deduplicated asset ids |
| `matched` | Used remote assets the manifest also records |
| `unregistered` | Used remote assets the manifest does not record, with the material's id, name, category, URL and creation stamp |
| `dangling` | Manifest records whose asset id the remote project does not hold |
| `issues` | Every defect in the manifest's own declarations, each with a stable `code` and the repair: no `items`/`assets` array, an asset array spelled `assets`, no `lead_readonly_records` array, or a record that is not an object. Additive to the file's original fields: the two external readers ignore a key they do not know |
| `disposition` | One `{status, note}` per unregistered asset, carried across runs |
| `blocking` | Unregistered asset ids with no `registered` or `ignored` decision |
| `ignored_without_note` | Ignored asset ids whose note is empty |
| `ready` | Whether `issues`, `blocking` and `ignored_without_note` are all empty |
| `policy` | The paid-generation policy the gate reads: KU_AI at 0.12 CNY per image, at most 3 attempts, 0.36 CNY worst case |

Two rules close the loop. An asset a person registers in the manifest is recognized on the next `reconcile` and its disposition becomes `registered` automatically, keeping whatever note it had. An asset that was used and whose material is still `Active` but whose asset row carries a `delFlag` other than `"0"` is not an asset: only alive rows are compared.

A manifest this comparison cannot read is reported, not refused. `jubian_organize` reads the same file and raises `CONTRACT_CHANGED` for an array it cannot find; `reconcile` answers `ready: false` with a structured `issues` entry instead, because this file is authored by a model that still has to repair it — an error ends the call and hides every other finding, while a reported issue arrives beside the whole `unregistered` and `dangling` list. The rows that could be read still take part, so an older manifest whose asset array is spelled `assets` compares its real rows rather than reporting every asset the remote already holds as unregistered. Only the three facts that leave nothing to compare at all — a missing file, a non-JSON body, and a missing integer `script_id` — still fail the call.

The tool result is not the evidence file. The file follows the pipeline's own spelling — an absent provider field is JSON `null` — while the tool result spells the same fact as an empty string or `0`, because the tool schema has no nullable scalar. `0` is never a category the provider issues, so `asset_type: 0` reads as "no category number".

`ready` is `issues`, `blocking` and `ignored_without_note` together: a comparison whose local side could not be read reports an asset the remote already holds as unregistered, and that verdict is what a paid creation would act on. `dispose` carries the `issues` the evidence already holds rather than recomputing them, so a disposition cannot turn that verdict back into a ready one. The host gate additionally requires a fresh `ran_at`, which `dispose` does not write: a project whose only evidence is a bare `dispose` result is reported `ready: true` and is still refused by the gate as unusable.

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

This section explains how one call is judged and where the code lives; the observable behavior is fully covered in [Use this package](#use-this-package).

### Reconciliation design

The package is built on three commitments:

- **The evidence file is a contract, not an output.** `_tools/asset_reconcile_report.py` in the production workspace and the host's `reconcileFirst` gate both read it. Field names, types and meanings are fixed by those readers, so this package ports them rather than designing them, and a schema mistake here is a silent failure in the check that exists to stop one.
- **Read-only remote, one local file.** The two Jubian calls are the provider's list endpoints. No write method, no billed method, and no second file: an unreconciled project must not become a project with a half-written manifest.
- **The comparison owns its ordering.** `unregistered` is written in ascending asset id order, which is what the pipeline's own report prints, so two runs over the same project produce comparable files.

### Source map

| File | Role |
|---|---|
| [`src/index.ts`](src/index.ts) | Plugin entry: `Config`, the credential resolution, the parameter schema and description, and the two spellings of a result |
| [`src/remote.ts`](src/remote.ts) | The two remote reads: page following, the reader-validated rows, and the provider fields the readers do not map |
| [`src/manifest.ts`](src/manifest.ts) | `assets_manifest.json` reading and the declared asset ids |
| [`src/matching.ts`](src/matching.ts) | Read-only identity, condition, voice/source checks and complete matching inventory reads |
| [`src/reuse.ts`](src/reuse.ts) | Centralized groups, evidence fingerprints and preserved-card previews; no confirmation or write executor |
| [`src/reconcile.ts`](src/reconcile.ts) | The comparison, the disposition carry-over, the verdicts, the evidence write, and `dispose` |
| [`src/types.ts`](src/types.ts) | Types only: the evidence document, the remote rows, and the manifest |
| — | No runtime invariant companion is published: the package holds no state between calls, exposes no snapshot, and every answer is a function of the files it reads and the two remote lists. |

</details>

-----

<a id="further-exploration"></a>
## Further Exploration

Read these pages when the package-level contract is not enough.

- [Generated tool catalog](../../../docs/tool-catalog.md#deepseek-aidsh-tool-drama-assets) — the exact `drama_assets` schema and description the model receives.
- [Tools subsystem reference](../../../docs/subsystems/tools.md) — the parameter DSL, the canonical output value, and the pipeline every call enters.
- [drama group map](../README.md) — the sibling packages of the short-drama pipeline.

-----

<a id="model-experience"></a>
## Model Experience

### The `drama_assets` tool schema

#### What the model sees

One tool named `drama_assets` in the request's tool list: this package's `description`, its seven parameters, and the JSON schema of its result, all reproduced in the generated [tool catalog](../../../docs/tool-catalog.md#deepseek-aidsh-tool-drama-assets). The description states the four methods, the three comparison rules (`delFlag == "0"`, `isUsed == 1` with `hsAssetStatus == "Active"`, `unregistered` / `dangling` / `matched`), the fact that `ready` is what the host gate reads, the 24-hour validity window, the accident the tool exists for, and the two things it never does. The result schema declares `method`, `ready`, `ready_reason`, `evidence`, `asset_id`, `script_id`, `ran_at`, `source`, `manifest`, `matched`, `unregistered`, `dangling`, `disposition`, `blocking`, `ignored_without_note`, `policy`, `cross_project_note`, and `next`; the rendered content is the same value as pretty-printed JSON. The fields a method does not report are absent from its value rather than defaulted, and the schema does not require them.

#### Token effect

Conditional and bounded by the project: the schema and the description are fixed, while the result grows with the unregistered and dangling lists — one row each, every row carrying the provider's own name, category, URL and creation stamp. A project with nothing to dispose returns the shortest useful answer.

#### KV Cache effect

Append-only. The tool registration carries a stable name, description, and schema, so a mounted row keeps the request prefix reusable; only a change to this package's description or schema invalidates it. A call's result is appended as that call's own tool result and rewrites no earlier message.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

These limits define what this package is and is not. They are current constraints, not a task backlog.

- **The comparison reads one page size** — both reads ask for the provider's documented maximum of 1000 rows and follow pages until the declared total is reached, so a project larger than that costs one request per 1000 rows. Nothing caps the walk.
- **The token may come from a workspace file** — with `workspaceSecrets` left on, the nearest `.agents/secrets/pipeline.env` supplies the token when the credential store holds none. That file is the pipeline's own secret store and is not this package's to manage.
- **`dispose` does not re-compare** — it edits the dispositions of the evidence it finds. An asset that became used remotely after the last `reconcile` is not in that evidence, so a disposition for it is recorded but never listed until the next `reconcile`.
- **`dispose` can write evidence with no comparison** — on a project that holds no evidence, `dispose` creates one holding only dispositions, `blocking`, `ignored_without_note` and `ready`. The host gate still refuses it, because it requires a fresh `ran_at` that only `reconcile` writes.
- **The manifest is the only local side** — assets recorded anywhere else (a `matches/*.json`, a pipeline state file) do not count as registered. Registering an asset means a row in `assets_manifest.json` with an integer `jubian_asset_id`.
- **A string `jubian_asset_id` counts as declared** — the manifest reader keeps integer ids only, so a row whose id is the string `"83840"` is not declared; it is not dangling either, because the dangling check reads the same field the same way, so the row is invisible to both lists.
- **`cross_project_note` is carried, never written** — the field is preserved from the previous evidence and returned; the cross-project search itself belongs to the `jubian-asset-library` skill.
- **The write is not transactional across processes** — the temporary file and the rename make one write atomic, but two concurrent `dispose` calls on one project can still interleave their read-modify-write cycles.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

This Dev Note is working context for maintainers: open questions and directions that are not decided. It is explicitly non-authoritative — shipped behavior, limits, and accepted rationale live in the sections above, the package code, and the linked documents.

The comparison is a port of the pipeline's `_tools/asset_reconcile.py`, and the port is field-for-field on purpose. That script stays in the production workspace and remains the reference for the evidence file's byte layout; this package is the path that does not need Python on the user's machine. `ready_reason` is the one field the Python tool writes that this one does not: it is derived, the host gate computes its own copy, and `reconcile` returns the same sentence in the tool result instead.

Token resolution uses the [shared Jubian workspace helpers](../../jubian/jubian/README.md), including the workspace secret fallback. `readAssetList` and `readMaterialList` stay the authority on what a page is, but this package reads `delFlag`, `createTime` and the two name spellings from the rows those readers accepted — the mappings do not carry them, and the evidence schema needs them.
</details>
