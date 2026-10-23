---
description: "Let an Agent search bounded character references and inspect verified images without exposing storage locations or granting use permission."
kind: "package-reference"
---

# @deepseek-ai/dsh-tool-character-reference

English | [中文](README.zh.md)

## Summary

`drama_character_reference_project` lists Host-validated projects; a unique project is automatic, while multiple projects require user selection. `drama_character_references` returns up to three metadata-ranked candidates with measured original-image SHA-256 after project-bible role verification. `drama_character_reference_view` rereads an exact Catalog ID and SHA, rejects identity changes, and sends image pixels only to image-capable models. Search is not viewing; the model supplies no paths or credentials.

Host-internal `characterReferenceAuthority` rechecks project, role, Catalog ID, and SHA for downstream consumers without changing review or authorization.

These read-only results grant no generation, reuse, binding, publication, or cross-project permission. `pending_review` permits viewing only, not production use.

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

When the Session `cwd` is itself a configured project root, the Host can use it directly. The Host can also use the sole valid project beneath the workspace without another human step. The Agent may call `drama_character_reference_project` with `action=list` and then `action=select` to read that unique project’s validated character IDs, names, role classes, and existing project-bound asset IDs. With multiple valid projects, the user must name one in the current conversation before `action=select`; listing and `drama_project read` never select among them. Only that explicit human selection persists in the live Session. A later human message naming another project requires a new selection, and a resumed Session cannot inherit an earlier explicit selection. The Host verifies project identity and directory on every lookup. Missing, ambiguous, changed, or unsafe projects are refused, with no arbitrary `project_dir` parameter.

The Agent supplies the selected project's `character_id`, a screenplay-derived `role_description`, and a `role_class` claim. The Host rereads the validated project bible through `readProjectBible` on each lookup and rejects an unknown character or a claim conflicting with a persisted role class before calling the library. If that class is absent, the Agent's claim may guide read-only search, and the result explicitly marks the uncertainty; it does not grant asset-use permission. Every registered role may be searched; the Agent decides whether a reference is useful from the screenplay. Optional `supporting_use_reason` records story context but neither permits the search nor authorizes asset use. Collection, era, gender, style, trait, and role terms narrow the internal search.

`character_id` identifies the project role. `catalog_asset_id` identifies a library candidate; `image_sha256` identifies its original image bytes. The Agent passes both candidate fields to `drama_character_reference_view` and may inspect, compare, choose, or decline candidates. These identities remain separate from supplier asset IDs.

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

[`src/index.ts`](src/index.ts) registers project selection, bounded search, image inspection, and the Host-internal authority service; it checks the exact model route's image capability before reading image bytes and persists the verified preview as a session attachment before returning its image block. [`src/project-context.ts`](src/project-context.ts) resolves only Host-validated project roots and uses a unique validated nested project automatically and requires human selection when multiple projects remain. [`src/project-role.ts`](src/project-role.ts) rereads the selected project through the public project-bible reader. [`src/authority.ts`](src/authority.ts) requires a persisted role class and rereads the current project, role, exact Catalog identity, and original-image SHA-256 for downstream Host consumers without changing review or authorization state. [`src/reference.ts`](src/reference.ts) validates the model claim, checks any persisted role class, and projects bounded Catalog fields without storage keys.

</details>

-----

<a id="model-experience"></a>
## Model Experience

### The `drama_character_references` tool

#### What the model sees

The `drama_character_references` result contains up to three Catalog identities, original-image digests, matched evidence, uncertainties, and explicit no-use flags. It contains no image block. `drama_character_reference_view` returns one image block beside its stable Catalog ID, original-image digest, current metadata status, and no-binding flag. The Agent may use the images to choose or abstain, but must not describe a candidate as approved or bound.

#### Token effect

The fixed schemas add three bounded tool definitions. Project listing returns at most 64 project IDs and titles; a selected project's role roster is limited to 128 records. Search returns at most three short candidate records; each explicit view adds one image to model context, subject to the deployment attachment and model limits.

#### KV Cache effect

Tool calls and results append to the conversation. Schema changes affect the reusable request prefix; search text and viewed image blocks affect later model requests. The attachment may be normalized for model input; the reported original SHA-256 continues to identify the source bytes.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

- The Host-owned library and its deployment provider must be configured; this package has no fallback to a local draft, arbitrary file, or caller-supplied object-store location.
- The current Agent Session must have an existing configured project root, a unique valid project beneath its workspace, or a human-confirmed selection among multiple projects. Its bible must contain the requested stable character ID. A missing role class permits uncertain read-only search from the Agent's claim, but downstream asset-use authorization still requires a persisted role class. This tool does not repair project data.
- Image inspection requires a durable attachment service and an exact model route that declares image input. A text-only route can search but cannot claim to have inspected a picture.
- It does not upload assets, publish metadata, change review state, bind a project character, call a supplier, or invoke paid generation.
- `pending_review`, `approved_claim`, and all other metadata states remain descriptive claims. This tool does not establish copyright, reuse rights, project approval, or production suitability.
- Role importance guides the Agent's search choice, not catalog metadata or a business-service lookup gate. Story context grants no use permission.
- Real Agent acceptance and any later approval-to-binding workflow require separate end-to-end evidence.

<a id="dev-note"></a>
### Dev Note

After editing both README languages, regenerate `README.i18n.yaml` with the repository translation-pairing generator.
