---
description: "Provide bounded Host-owned browsing, preview and recommendation for character references."
kind: "package-reference"
---

# @deepseek-ai/dsh-character-library

English | [中文](README.zh.md)

## Summary

Expose one Host-owned domain service for browsing, inspecting, previewing and deterministically recommending public character references. The service consumes `@deepseek-ai/dsh-character-asset-catalog` records instead of defining another metadata parser. The service remains read-only and exposes no intake or use authorization.

Every entry remains a reference claim. `pending_review` records may participate in recommendation, but `canPublish`, `canReuse`, `canBind` and `applyAllowed` remain `false`. Catalog asset, project character and supplier asset identities are never combined.

## Table of Contents

- [Use this package](#use-this-package)
- [Recommendation policy](#recommendation-policy)
- [Object-store boundary](#object-store-boundary)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)
- [Dev Note](#dev-note)

-----

<a id="use-this-package"></a>
## Use this package

Register a `CharacterLibraryObjectStore` provider before constructing `CharacterLibrary`. The store owns credentials, transport and deployment readiness. `status()` must be a zero-I/O readiness check; a missing or unhealthy read configuration is reported as `configured: false`, and all read operations fail before object I/O.

The service fixes the logical source to `muse-character-reference-qa` and reads only these reviewed historical prefixes:

- `assets/reference/characters/stylized/ancient/ancient/`
- `assets/reference/characters/stylized/urban/urban/`

`browse()` lists bounded metadata pages and returns catalog projections. `detail()` resolves one catalog identity without reading image bytes. `preview()` asks the catalog loader to read and verify one bounded image in memory, then fully decodes structurally valid JPEG, PNG or WebP data with fixed pixel and time limits. It rejects a changed metadata object, catalog identity, image key or caller-supplied original-image SHA-256. No method returns a public URL or changes catalog approval.



<a id="recommendation-policy"></a>
## Recommendation policy

`recommend()` receives structured role requirements and returns exactly one of `recommended`, `needs_review` or `no_match`. A lead role may search normally. `important_support`, `support` and `extra` roles skip the library unless the Host supplies a bounded, non-empty `supportingUseReason`; that exception is included in the explanation and uncertainties rather than stored in catalog metadata.

Declared era conflicts reject a candidate. Equal top scores produce `needs_review`; catalog IDs never break a semantic tie. This is an internal review state, not a request for the user to choose from a candidate list. Consumers should report that the result needs review and must not treat it as permission to apply an asset.

`matchCandidates()` applies the same bounded metadata scoring, ranks up to three distinct candidates, verifies each original image and returns its measured SHA-256. An over-limit result includes `candidate_limit_reached`; the Agent may refine its requirements and search again. The ranking is an initial filter, not a visual choice or an authorization decision. An Agent consumer must separately deliver the selected candidate image as a durable image content block and recheck its catalog ID and original-image SHA-256 with `preview()` before relying on that choice.

<a id="object-store-boundary"></a>
## Object-store boundary

`CharacterLibraryObjectStore` exposes only bounded List, Head and Get operations; it has no intake, delete, copy, move, ACL, policy or presigned-URL operation.

The package does not define a TOS bucket, mutable index, credential reference or IAM policy. It also does not register an Agent tool or production profile.

-----

<a id="model-experience"></a>
## Model Experience

### Character-reference recommendation

#### What the model sees

This package contributes no model tool, prompt or Session event. A separate Host consumer may expose up to three `matchCandidates()` results and supply actual image content for Agent inspection. Text-only matches do not establish that the Agent saw an image, and neither a match nor a preview grants production use.

#### Token effect

The package itself adds no model tokens. A consuming tool owns field selection and output bounds.

#### KV Cache effect

The package does not construct model requests and defines no cache-prefix behavior.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

- Store/provider configuration, TOS transport, IAM and credentials belong to deployment packages and remain outside this package.
- Match ranking is deterministic bounded text matching over source claims. The domain verifies image bytes and catalog identity but does not perform visual judgment or grant approval.
- `needs_review` does not authorize application and must not become a user-facing candidate picker.
- Production TOS upload, index publication, project binding, supplier generation and production Agent registration remain unavailable.

<a id="dev-note"></a>
### Dev Note

Do not add a second metadata parser or enable production writes.
