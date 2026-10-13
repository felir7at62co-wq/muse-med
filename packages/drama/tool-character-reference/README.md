---
description: "Recommend at most one verified local character reference from an unpublished draft index for isolated QA, without uploads, bindings, or writes."
kind: "package-reference"
---

# @deepseek-ai/dsh-tool-character-reference

English | [中文](README.zh.md)

## Summary

Use `drama_character_references` in an isolated QA profile to compare a bounded role request with an unpublished local character-reference draft. The tool validates the index, its v2 metadata, and image hashes before returning at most one reference with evidence and uncertainties. It returns no recommendation for an unverified era, insufficient evidence, or a tied score. The lookup never uploads assets, binds a production project, writes files, or makes paid requests.

## Table of Contents

- [Use this package](#use-this-package)
- [Understand the implementation](#understand-the-implementation)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)
- [Dev Note](#dev-note)

-----

<a id="use-this-package"></a>
## Use this package

Mount the plugin only in an isolated QA composition and provide an absolute path to the unpublished `character_reference_index.draft.json`. Shipped profiles do not load it.

| Field | Default | Meaning |
|---|---|---|
| `referenceIndexPath` | required | Absolute path fixed by the QA profile; it is never accepted as an Agent tool argument or a TOS URL. |

The plugin registers only `drama_character_references`. The caller supplies a script-derived `role_description` and any supported style, tag, or era requirements that are actually known. `pending_review` entries may remain candidates, but a returned reference is never an approval or an asset binding.

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

[`src/index.ts`](src/index.ts) fixes the index path in deployment configuration and registers the read-only tool. [`src/reference.ts`](src/reference.ts) keeps referenced metadata and images inside the configured draft root, verifies the draft and file hashes, then ranks exact declared evidence. The result reports `read_only=true`, `apply_allowed=false`, `local_writes=0`, `remote_writes=0`, and `paid_requests=0`.

</details>

-----

<a id="model-experience"></a>
## Model Experience

### The `drama_character_references` tool

#### What the model sees

The model receives a fixed `drama_character_references` tool with `role_description` plus optional `style`, `desired_tags`, and `era`. The result is `recommended`, `no_match`, or `needs_review`; it contains at most one local QA reference, the reason, sourced evidence, uncertainties, and explicit no-write flags. The model must describe the item as a reference rather than an approved or bound production asset.

#### Token effect

The tool schema is fixed. One appended result is bounded to one recommendation and its evidence or to a short explanation that no reliable recommendation exists.

#### KV Cache effect

Tool results append without rewriting earlier messages. Changes to the tool description or schema change the reusable request prefix; changing the local draft affects only a later tool result.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

- This package is available only to an explicitly configured isolated QA profile; no shipped production profile registers it.
- It reads one fixed local draft. It has no upload path, TOS publication, index writer, formal character-library UI, import operation, or production-project binding.
- Matching uses declared local labels and exact evidence. It does not call a vision model, perform semantic scoring, or verify the caller's role description against the script.
- `pending_review` is not approval. Copyright, reuse rights, identity, age, gender, and production suitability still require the responsible human review.
- Offline tool checks and simulated Agent sessions do not establish real-model acceptance. A real Agent Session remains separately pending.

<a id="dev-note"></a>
### Dev Note

None.
