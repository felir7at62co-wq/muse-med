---
description: "Read reviewed public character references from fixed Volcengine TOS prefixes with bounded List, Head, and ranged Get operations."
kind: "package-reference"
---

# @deepseek-ai/dsh-character-library-tos

English | [中文](README.zh.md)

## Summary

`@deepseek-ai/dsh-character-library-tos` provides bounded reads from the reviewed Muse character-reference prefixes in Volcengine TOS. The endpoint, region, bucket and prefixes are fixed security invariants. Explicit `publicRead: true` reads the public object catalog without credentials; otherwise the provider resolves deployment credential references when a read starts. With neither mode configured, it reports `readConfigured: false`.

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

Muse Web and Desktop enable `publicRead: true` to list the two reviewed prefixes directly from TOS. Every catalog request reads a live page, so cloud additions, metadata changes and deletions become available on subsequent reads without restarting or publishing the application. Public mode requires anonymous ListObjects access restricted to these prefixes and GetObject access for their metadata and images. It loads neither credentials nor the SDK. Domain metadata-status and image-verification rules still apply.

To enable automatic discovery, merge the statement from [`muse-public-list.policy.json`](config/muse-public-list.policy.json) into the existing bucket policy, preserving its other statements. It grants anonymous `ListBucket` access only for the two exact prefixes. Metadata and images still require their existing public GetObject access; the example grants no object writes.

For an authenticated deployment, leave `publicRead` false and set both `readAccessKeyIdRef` and `readSecretAccessKeyRef` to Host `ctx.credentials` references. A partial pair or combining references with public mode is rejected at plugin load. Public mode defaults to false; failed authenticated reads never switch modes. Secret values never enter errors.

`connectionTimeoutMs` defaults to 10000 and is limited to 30000. `requestTimeoutMs` defaults to 30000 and is limited to 60000. The locked runtime dependency is `@volcengine/tos-sdk@2.9.1`, configured with zero automatic retries.

<a id="read-and-write-safety"></a>
## Read and write safety

Authenticated reads use `ListObjectsV2`, `HeadObject` and ranged `GetObjectV2`. Public reads use anonymous HTTP ListObjectsV2, HEAD and ranged GET under these historical prefixes:

- `assets/reference/characters/stylized/ancient/ancient/`
- `assets/reference/characters/stylized/urban/urban/`

Every returned key is checked again. Each listing makes one request for at most 128 objects and preserves the service's opaque continuation token; only safe character-directory `metadata.json` entries become catalog records. Public listing responses must be valid TOS JSON within 1 MiB; when `KeyCount` is zero, omitted or null `Contents` means an empty page. Object bodies require a valid partial-content response and are stopped at the caller's byte limit.



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

- Configured status describes the selected read mode. Reads still fail if public access is removed or referenced secrets are absent.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

The fixed historical read prefixes are security invariants, not evidence for a future upload layout.

</details>
