---
kind: upgrade-guide
description: Hongguo catalog inspection reports unverified media availability and safe upstream errors.
---

# Hongguo source availability

English | [中文](guide.zh.md)

## Change

Catalog inspection no longer declares a full series available without querying media. `hongguo_download_info` returns `fullSeriesAvailable: null` and `mediaUrlsVerified: false`; a public preview still returns `fullSeriesAvailable: false`. Non-public `accessibleEpisodeCount` is null rather than the unverified total. Source API failures retain safe numeric `upstreamCode`, `sourceStage` and `retryable: false`, including errors in uppercase `Code` and `BaseResp.StatusCode` envelopes. They are not reported as missing media addresses. Unknown business errors stop without retrying or rotating the device; explicit risk messages retain the bounded retry budget.

The original media lookup uses the single-video `/novel/player/video_model/v1/` endpoint with `video_id`, matching Hongguo Downloader 1.0.0.73. Download grouping still retains every requested episode; the obsolete multi-video endpoint is not a fallback.

Empty HTTP 200 bodies return `empty_source_response` instead of `platform_json`. Empty and malformed JSON replies include `httpStatus`, `responseBytes`, `sourceStage` and `retryable: false`; response contents remain private.

## Migration

1. Update consumers of the [download plugin](../../../../third_party/plugins/muse-hongguo-download/README.md) to accept nullable availability and accessible counts. Use `completeCatalog` only for catalog completeness.
2. Confirm actual download success with the `hongguo_download` receipt, requested episode coverage and full decoding; do not use catalog inspection as a download acceptance check.
3. Treat exhausted platform failures as requiring diagnosis of the source stage and numeric code. Do not infer that the requested title is unavailable or immediately repeat the same exhausted download.
4. Handle `empty_source_response` explicitly without regenerating device identities or assuming a platform-wide outage. Validate new-install media downloads separately from retained configurations. After manually restoring a valid private local configuration, restart the client to clear its cached source.
