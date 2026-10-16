---
description: "Read reviewed public character references from fixed Volcengine TOS prefixes with bounded List, Head, and ranged Get operations."
kind: "package-reference"
---

# @deepseek-ai/dsh-character-library-tos

English | [中文](README.zh.md)

## Summary

`@deepseek-ai/dsh-character-library-tos` provides the Host object-store service for bounded reads from the reviewed historical Muse character-reference prefixes in Volcengine TOS. The endpoint, region, bucket and two readable prefixes are fixed security invariants. An unconfigured provider mounts safely and reports `readConfigured: false`; it resolves deployment credential references only when a read starts.

## Table of Contents

- [Use this package](#use-this-package)
- [Read and write safety](#read-and-write-safety)
- [Understand the implementation](#understand-the-implementation)
- [Further Exploration](#further-exploration)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)
- [Dev Note](#dev-note)

-----

<a id="use-this-package"></a>
## Use this package

Set both `readAccessKeyIdRef` and `readSecretAccessKeyRef` to credential references owned by the Host `ctx.credentials` service. Setting only one reference is rejected during plugin loading. The provider never reads ambient secret variables directly and never includes secret values in errors.

`connectionTimeoutMs` defaults to 10000 and is limited to 30000. `requestTimeoutMs` defaults to 30000 and is limited to 60000. The locked runtime dependency is `@volcengine/tos-sdk@2.9.1`, configured with zero automatic retries.

<a id="read-and-write-safety"></a>
## Read and write safety

Reads are limited to `ListObjectsV2`, `HeadObject` and ranged `GetObjectV2` calls under these historical prefixes:

- `assets/reference/characters/stylized/ancient/ancient/`
- `assets/reference/characters/stylized/urban/urban/`

Every returned key is checked again. Listing is bounded to one SDK transport request and at most 128 objects. Object bodies require a valid partial-content response and are stopped at the caller's byte limit.



-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>


</details>

-----

<a id="further-exploration"></a>
## Further Exploration

- [Character Library domain](../character-library/README.md) — store interface and read-only product behavior.
- [Credentials](../../credentials/credentials/README.md) — Host-owned credential references and secret resolution.

-----

<a id="model-experience"></a>
## Model Experience

### TOS-backed library reads

#### What the model sees

The model sees no direct contribution from this provider. It registers no tool, prompt section, or Session event; a separate consumer owns any bounded projection of catalog records.

#### Token effect

`ListObjectsV2`, `HeadObject`, and ranged `GetObjectV2` operations add no model-request tokens by themselves.

#### KV Cache effect

Provider configuration and object reads do not alter a model request or its reusable prefix.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

The provider has these limits.

- Configured status describes credential-reference configuration only. The first read still fails closed if the referenced secrets are absent.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

The fixed historical read prefixes are security invariants, not evidence for a future upload layout.

</details>
