---
description: "Adapt character reference metadata into source-scoped catalog records and compare image bytes through a caller-owned reader."
kind: "package-reference"
---

# @deepseek-ai/dsh-character-asset-catalog

English | [中文](README.zh.md)

## Summary

Adapt flat character metadata, explicit Phase 1 v2 metadata and unversioned legacy aliases into catalog records while preserving source claims. Supply exact metadata keys and a read-only reader to measure image bytes and compare any declared size or SHA-256. Keep catalog, reference, project and supplier identities separate. Parsing and byte verification grant no publication, reuse or binding approval.

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

Use this library when a caller needs consistent character records from metadata with different field names. It exports a module API through [`src/index.ts`](src/index.ts); it registers no plugin, tool or profile configuration.

`parseCharacterMetadata(json, source, key)` parses JSON using an operator-configured logical source namespace and the exact relative metadata key. Flat metadata uses `asset_id` and `file_name`; older aliases are `id` and `images[0].filename`. Both alias sets may appear together only when their values agree. Only explicit `schema_version=2` identifies Phase 1 v2; unversioned old-only fields are labeled `legacy_aliases`. The parser retains the source JSON data and records which aliases supplied each value. It derives the image key from the metadata directory and declared filename, preserving every directory level.

`adapted.asset_id` and `adapted.file_name` expose the normalized aliases; `identity.original_asset_id` remains the separately typed original identity.

`loadCharacterAssets(source, metadataKeys, reader)` reads only the explicit metadata keys and their referenced images through the supplied `CharacterObjectReader`. It returns observed byte lengths and SHA-256 values, compares declared values when present, and rejects duplicate catalog identities within that source. Unavailable objects, malformed metadata, conflicting aliases or image mismatches reject the call without returning partial records. The caller owns the reader's access policy and effects; this package provides no TOS client, credential resolution, object listing or storage writes.

### Identity and source claims

| Identity | Meaning |
|---|---|
| Storage source ID | A stable logical namespace configured by the operator, independent of a bucket or object key. |
| Original asset ID and catalog asset ID | The metadata's local ID and its namespaced `character:<source>:<original-id>` catalog identity. Neither is a supplier asset ID. |
| Phase 1 reference ID | The original v2 reference identity; flat metadata does not acquire one automatically. |
| Project character and supplier asset/material IDs | Separate identities with explicit project or provider/account scope in association types. Parsing creates no association. |

The record separates retained metadata, adapted claims, derived keys, observed bytes and unknown authority. An explicit v2 `style` becomes a setting claim; a flat `style` becomes an art-style claim. Unversioned legacy aliases infer neither style meaning. Era, gender and appearance remain source claims, and appearance entries retain their metadata locations. `approved` and `rejected` status text becomes an approval or rejection claim, never an authoritative decision. Review, rights, reuse scope and TOS object version remain unknown; `can_publish`, `can_reuse` and `can_bind` remain false.

`raw.metadata` retains the complete parsed source object. `unknown.metadata_fields` separately preserves unrecognized top-level keys and their values verbatim as own data properties, including names such as `__proto__`; it is distinct from the unknown review, rights, reuse and TOS authority fields. Retaining a field does not validate its meaning or make it authoritative.

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

[`src/metadata.ts`](src/metadata.ts) validates the fields needed for adaptation, resolves matching aliases and combines a logical namespace with the original identity. The loader uses caller-supplied reads to distinguish measured image bytes from metadata declarations. [`src/types.ts`](src/types.ts) keeps those observations separate from source claims and approval authority; [`tests/metadata.spec.ts`](tests/metadata.spec.ts) exercises the format distinctions and rejection behavior.

</details>

-----

<a id="further-exploration"></a>
## Further Exploration

- [Phase 1 character reference lookup](../tool-character-reference/README.md) — the separate local draft recommendation tool and its isolated QA scope.
- [Branded identities](../../util/brand/README.md) — compile-time separation of identities with the same primitive representation.
- [Architecture](../../../docs/architecture.md) — composition and ownership of product capabilities.

-----

<a id="model-experience"></a>
## Model Experience

### Catalog records

#### What the model sees

This library contributes no model tool, prompt text or Session event. Callers receive `CharacterMetadataRecord` or `VerifiedCharacterAsset` values through the module API and own any later presentation; the existing Phase 1 QA tool is not connected to this library.

#### Token effect

The library adds no request tokens. A caller that presents its records owns the selection and size of that model-visible content.

#### KV Cache effect

The library does not construct or modify model requests. It defines no request-prefix or cache-reuse behavior.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

- Object discovery, source adapters, TOS access, index publication, UI, project binding and supplier operations belong to callers or separate packages; none are provided here.
- Byte verification checks size and SHA-256, not image decoding, visual content, identity, age, era suitability or source authorization.
- The parser validates adaptation fields, not every retained metadata field or a complete v2 JSON Schema. It adapts only the first entry of an `images` array.
- Source status and review fields remain claims. The package cannot approve publication or reuse, and it does not change the existing Phase 1 QA workflow.

<a id="dev-note"></a>
### Dev Note

None.
