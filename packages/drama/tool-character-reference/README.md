---
description: "Let an Agent search bounded character references and inspect verified images without exposing storage locations or granting use permission."
kind: "package-reference"
---

# @deepseek-ai/dsh-tool-character-reference

English | [中文](README.zh.md)

## Summary

`drama_character_references` returns up to three metadata-ranked references with measured original-image SHA-256. The Host verifies the Agent Session's `project_config.json` character and claimed role before library access. The model cannot supply storage locations or credentials. `drama_character_reference_view` rereads a candidate by Catalog ID, rejects changed image identity, and returns a durable image block only to an image-capable model route. Search text is not visual inspection.

Every outcome denies publication, reuse, binding, and application. A `pending_review` item may guide selection but remains unavailable for production use.

## Table of Contents

- [Use this package](#use-this-package)
- [Understand the implementation](#understand-the-implementation)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)
- [Dev Note](#dev-note)

-----

<a id="use-this-package"></a>
## Use this package

Mount this plugin only in a Host composition that already provides `tools`, `settings`, and the read-only `characterLibrary` service. The plugin has no configuration for paths, TOS locations, uploads, writes, or supplier operations.

The Agent supplies the current project `character_id`, a screenplay-derived `role_description`, and a `role_class` claim. The Host obtains the project root only from the current Session `cwd`, reads the validated project bible through `readProjectBible`, and rejects a missing workspace, unconfigured project, unknown character, missing persisted role class, or conflicting claim before calling the library. Lead roles may search by default. Any non-lead role is skipped by the domain service unless `supporting_use_reason` states a bounded, story-specific exception. Optional collection, era, gender, style, trait, and role terms narrow the internal search.

`character_id` identifies the project role. `catalog_asset_id` identifies a library candidate; `image_sha256` identifies its original image bytes. The Agent passes both candidate fields to `drama_character_reference_view` and may inspect, compare, choose, or decline candidates. These identities remain separate from supplier asset IDs.

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

[`src/index.ts`](src/index.ts) registers bounded search and image inspection, checks the exact model route's image capability before reading image bytes, and persists the verified preview as a session attachment before returning its image block. [`src/project-role.ts`](src/project-role.ts) resolves the Session workspace through the public project-bible reader. [`src/reference.ts`](src/reference.ts) validates the model claim, requires an exact authority match, and projects bounded Catalog fields without storage keys.

</details>

-----

<a id="model-experience"></a>
## Model Experience

### The `drama_character_references` tool

#### What the model sees

The `drama_character_references` result contains up to three Catalog identities, original-image digests, matched evidence, uncertainties, and explicit no-use flags. It contains no image block. `drama_character_reference_view` returns one image block beside its stable Catalog ID, original-image digest, current metadata status, and no-binding flag. The Agent may use the images to choose or abstain, but must not describe a candidate as approved or bound.

#### Token effect

The fixed schemas add two bounded tool definitions. Search returns at most three short candidate records; each explicit view adds one image to model context, subject to the deployment attachment and model limits.

#### KV Cache effect

Tool calls and results append to the conversation. Schema changes affect the reusable request prefix; search text and viewed image blocks affect later model requests. The attachment may be normalized for model input; the reported original SHA-256 continues to identify the source bytes.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

- The Host-owned library and its deployment provider must be configured; this package has no fallback to a local draft, arbitrary file, or caller-supplied object-store location.
- The current Agent Session must have an existing workspace whose project bible contains the requested stable character ID and a persisted role class. This tool does not infer either field or repair project data.
- Image inspection requires a durable attachment service and an exact model route that declares image input. A text-only route can search but cannot claim to have inspected a picture.
- It does not upload assets, publish metadata, change review state, bind a project character, call a supplier, or invoke paid generation.
- `pending_review`, `approved_claim`, and all other metadata states remain descriptive claims. This tool does not establish copyright, reuse rights, project approval, or production suitability.
- Non-lead policy is owned by the business service rather than catalog metadata. A supporting-role exception permits lookup only; it does not grant use permission.
- Real Agent acceptance and any later approval-to-binding workflow require separate end-to-end evidence.

<a id="dev-note"></a>
### Dev Note

After editing both README languages, regenerate `README.i18n.yaml` with the repository translation-pairing generator.
