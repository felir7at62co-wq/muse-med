---
kind: upgrade-guide
description: Hongguo catalog inspection reports unverified media availability and safe upstream errors.
---

# Hongguo source availability

English | [中文](guide.zh.md)

## Change

Catalog inspection no longer declares a full series available without querying media. `hongguo_download_info` returns `fullSeriesAvailable: null` and `mediaUrlsVerified: false`; a public preview still returns `fullSeriesAvailable: false`. Non-public `accessibleEpisodeCount` is null rather than the unverified total. Source API failures retain safe numeric `upstreamCode`, `sourceStage` and `retryable: false` after bounded attempts, including errors in uppercase `Code` and `BaseResp.StatusCode` envelopes. They are not reported as missing media addresses.

## Migration

1. Update consumers of the [download plugin](../../../../third_party/plugins/muse-hongguo-download/README.md) to accept nullable availability and accessible counts. Use `completeCatalog` only for catalog completeness.
2. Confirm actual download success with the `hongguo_download` receipt, requested episode coverage and full decoding; do not use catalog inspection as a download acceptance check.
3. Treat exhausted platform failures as requiring diagnosis of the source stage and numeric code. Do not infer that the requested title is unavailable or immediately repeat the same exhausted download.
