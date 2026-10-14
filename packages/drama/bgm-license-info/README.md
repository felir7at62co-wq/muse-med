---
description: "Music-rights declarations, explicit unknown metadata and advisory intended-use conflicts for BGM consumers."
kind: "package-library"
---

# BGM license information

English | [中文](README.zh.md)

## Summary

`@deepseek-ai/dsh-bgm-license-info` normalizes music-rights declarations for catalog publication, candidate matching, downloads, composition plans and render reports. It reports missing evidence and explicit commercial-use conflicts without approving music use.

## Table of Contents

- [Declaration fields](#declaration-fields)
- [Consumers](#consumers)
- [Dev Note](#dev-note)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)

<a id="declaration-fields"></a>

## Declaration fields

`license_info` carries `license`, `commercial_use`, `source`, `attribution`, `scope` and a derived `status`. Text fields use `unknown` when absent or blank; `commercial_use` is a boolean or `unknown`. Its `source` identifies the rights evidence, independently of an audio URL or filesystem path. `status=declared` means the supplied fields are complete, not legally verified. Missing facts produce `status=unknown`; a claimed `commercial_use=true` without license, source and scope becomes `unknown`. Malformed types and unsupported approval statuses fail validation. No permission is inferred from a filename, mood, successful download, hash or software license.

`intended_use` is `commercial`, `non_commercial` or `unknown`. `licenseRiskWarnings` reports incomplete declarations, unspecified purpose and an explicit `commercial_use=false` conflict with commercial use. Findings are advisory; an empty list never grants rights. Free-form scope restrictions remain source declarations for the operator to assess.

<a id="consumers"></a>

## Consumers

`normalizeLicenseInfo` validates external metadata; `LicenseInfoInputSchema` provides the same normalization for plans. `LICENSE_INFO_TOOL_SCHEMA` and `BGM_LICENSE_RECORD_TOOL_SCHEMA` describe the canonical tool results. `BgmLicenseRecord` associates a declaration with a track, audio source and optional catalog ID or digest. The library has no filesystem, network or model calls.

<a id="dev-note"></a>

## Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

None.

</details>

<a id="model-experience"></a>

## Model Experience

### Rights declarations and findings

#### What the model sees

Consumers render `license_info` and per-track warnings in their existing tool results. This library itself registers no prompt or tool; `declared` expresses supplied facts, and `unknown` preserves missing evidence without granting permission. Matching-model licensing remains independent.

#### Token effect

The additional declaration and warning fields increase result tokens in proportion to the number of reported tracks; the library makes no model requests.

#### KV Cache effect

Consumers append the fields to logged tool results. Their normal transcript and schema updates determine cache reuse; this library changes no cache policy.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

- Structural validation does not authenticate a catalog issuer, verify a rights document or prevent an author from supplying false facts. Caller-authored plans remain declarations. The library neither interprets legal scope text nor replaces independent MERT licensing requirements. It does not populate or publish any real track's rights data.
