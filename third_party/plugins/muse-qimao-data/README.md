---
description: "Public Qimao ranking and filtered-library metadata for Muse users choosing novel sources and maintainers diagnosing partial coverage."
kind: "package-bundle"
---

# Muse Qimao metadata

English | [中文](README.zh.md)

## Summary

Muse creative presets use this bundle's scoped provider to read public Qimao ranking windows, filtered library pages and book details. The provider preserves platform metric names, observation times, missing values and collection coverage. It does not log in, evaluate page JavaScript, follow chapter links or download novel text. Current-reader counts and App golden-selection status remain unknown.

## Table of Contents

- [Use this package](#use-this-package)
- [Understand the implementation](#understand-the-implementation)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)
- [Dev Note](#dev-note)

<a id="use-this-package"></a>
## Use this package

### Profile activation

The Desktop source-package inventory carries the bundle. Standard, PTC, Cordis, Short Drama, Editing and Bot Coordinator presets activate its provider in their own scope; Minimal does not. The bundle patch contributes a disabled global entry, so adding its package to a profile alone does not make the tools globally available. Custom compositions must explicitly enable the `muse-qimao-data` row in the intended agent scope.

### Public metadata and coverage

`qimao_rankings` defaults to the initial windows of both channels and all five boards, with day/month windows for the hot board. Rank pagination is unverified and cannot be requested. `source:library` reads real numbered pages of the public recent-short-ongoing filter: updated within three days, below 300,000 words, ongoing, sorted by clicks. Its default page budget is three. The result describes this filter rather than claiming all Qimao books.

`qimao_search` filters book titles and authors within the requested collected windows. It always reports `complete:false`, along with the matching and scanned counts; absence from that window is not absence from Qimao. `qimao_detail` checks the requested decimal book ID against the primary metadata panel and returns no chapter body. Book IDs remain strings.

Every count retains its displayed label, raw text, numeric interpretation, precision, observation time and missing reason. Heat, cumulative popularity and read occurrences remain separate. Read occurrences do not establish current readers; cumulative popularity does not establish daily votes. `currentReaders` and `goldenPick` are always `null`. Repeated books retain the metadata with the latest fetch time and each known metric with the latest metric observation time, even when an older cached window is traversed later; missing values cannot erase known metrics.

`coverage.complete` means all requested public pages succeeded; `coverage.siteWide` is always false. `coverage.metrics` separately counts known and missing fields across fetched observations. Wrong active selections, repeated library pages and mismatched detail IDs are rejected. Partial collection results retain successful pages and explicit failures; a completely failed collection throws. Failed requests are not replaced with old cached data.

### Configuration

Validated settings are `requestTimeoutMs` (default 15,000), `maxResponseBytes` (5 MiB), `requestIntervalMs` (800), `cacheTtlMs` (300,000), `maxCacheEntries` (128), `maxPages` (3, allowed 1–10) and `allowLegacyResponseHeaders` (true). The cache retains each original observation time and expires by TTL; `refresh:true` bypasses it. The client accepts only generated official HTTPS metadata paths, sends no account credentials, rejects redirects, and cancels owned reads on unload.

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals</summary>

[The parser](src/parser.js) uses parse5 to read only observed metadata DOM classes. [The client](src/client.js) owns selection validation, rate-limited requests, page caches, deduplication and explicit coverage. [The transport](src/transport.js) keeps TLS validation enabled and bounds response bodies. Strict fetch is preferred; the observed header-parser or Undici response-length exception can use one request-local HTTPS compatibility attempt when configured. That attempt requires completed HTTP framing and an actual byte count matching Content-Length when supplied; ambiguous framing and incomplete bodies fail. This fixed-origin path does not relax global HTTP or TLS settings and never retries an access-denied response or verification page.

[The patch](cordis.patch.yml) is globally disabled; [the entry](src/index.js) registers tools through the active scope and awaits owned request cleanup. The [public types](src/index.d.ts) keep book IDs branded for typed consumers. [The packaging script](scripts/pack.mjs) packs reviewed files in private staging and records their hashes, the matching Host version, dependencies and upstream reference in `SOURCE.json`. The [third-party notice](THIRD_PARTY_NOTICES.md) preserves the MIT reference scanner's attribution; its Chrome/CDP driver is not shipped.

</details>

<a id="model-experience"></a>
## Model Experience

The scoped provider contributes three read-only tool descriptions and result schemas. Initial ranking windows, filtered-library bounds, unknown App fields and window-only search remain explicit in their model-visible results. Generic read/search cards display the raw tool result without adding completion claims.

<a id="known-limitations-and-deferred-work"></a>
## Known Limitations and Deferred Work

Public HTML, ranking composition and access availability can change. A verification or blocked page fails explicitly; the provider does not bypass it. The package does not provide App-only current-reader or golden-selection fields, novel-text downloading, public keyword search over the entire site, or verified rank pagination. Metadata success does not establish adaptation rights or complete novel availability. Synthetic tests do not establish current live-site availability.

<a id="dev-note"></a>
## Dev Note

<details>
<summary>Working context for maintainers</summary>

The synthetic fixtures retain the observed metadata classes while replacing titles, descriptions and counts. They include chapter and script sentinels so the real parser and scoped tools can verify that neither content reaches the tool result. Live acceptance remains a bounded read of selected public metadata pages.

</details>
