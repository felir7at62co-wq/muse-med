# Fixed Lvpaopao operations

English | [中文](README.zh.md)

This module provides owned fixed expressions and a socket-free registration adapter. A trusted helper selects the authenticated target/context and constructs `NativeRpc` with an explicit operation allowlist. Registration alone does not attach to WeChat or execute business calls. Deployment and qualification limits belong to the [helper guide](../../../README.md).

```python
from native_rpc import NativeRpc
from operations.fixed_operations import fixed_operations, call_operation

registry = fixed_operations(['status', 'search', 'detail', 'episodes'])
rpc = NativeRpc(send_frame, 'wx404dde55fb12df78', registry,
                initial_sequence=discovery_seq,
                initial_op_id=discovery_op_id,
                initial_cdp_id=discovery_cdp_id)
await rpc.verify_context(selected_native_context, selected_execution_context)
model_result = await call_operation(rpc, 'search', {'query': '老手'})
```

## Operation fields

| Operation | Caller parameters | Maximum business calls | Additional public fields |
| --- | --- | --- | --- |
| `status` | `{}` | 0 | `hasRequire`, `hasBizRequest`, `hasNativeWrapper` |
| `search` | `{query}` | 1 | `resultCount`, `partial`, `candidates[{title,srcAppId,originDramaId}]` |
| `detail` | `{srcAppId,dramaId}` | 1 | `srcAppId`, `dramaId`, `title`, `episodeCount`, `isFirstMediaFree`, `hasVideoInfo`, `hasPlayAuthorization` |
| `engagement` | `{srcAppId,dramaId,episodeNo}` | 1 | Source identity, actual episode number, `observedAtMs`, nullable `counts{likes,comments,recommendations,shares}` |
| `episodes` | `{srcAppId,dramaId,start,count}` | 2 | Detail fields, `requestedStart`, `requestedEndExclusive`, `episodeNumbers`, `partial` |
| `download_first_episode` | `{srcAppId,dramaId}` | 2 | Detail fields, `serialNo`, `isStraight`, `hasPrivateMedia` |
| `download_episode` | `{srcAppId,dramaId,episodeNo}` | 2 | Detail fields, actual `serialNo`, `isStraight`, `hasPrivateMedia` |

The registry uses the real `native_rpc.FixedOperation` type. It rejects unknown parameter keys and supplies one fixed tag and validated parameters through `@@PARAMS@@`. `NativeRpc` handles JSON escaping, fresh target identity, context correlation, serial dispatch, sequence counters and bounded receipts. Expressions use the existing plugin namespace and fixed host modules; caller input cannot select arbitrary code or a module path.

Public metadata includes operation/status, matched identity, app/plugin/login state, business-call count and timeout state. Failures return fixed codes. Optional diagnostics contain only fixed failure phase/category and a numeric-or-null native code; they never retain raw errors, stacks, tokens or playback addresses. A business-call count alone does not establish whether provider execution finished.

## Validation and lifecycle

Queries contain at most 80 Unicode code points. App IDs use `wx` plus sixteen lowercase hexadecimal characters. Drama IDs remain opaque 1–128-character strings, preserving leading zeros. Safe nonnegative numeric response IDs may be converted exactly; unsafe IDs are omitted and mark search results partial. Search returns at most fifty actual candidates.

Episodes first reads current detail, then accepts one-based `start` and a count of 1–20. The provider receives an exclusive end: episodes 1–20 use `end_no=21`. Results contain only distinct actual returned episode numbers in numerical order. Missing, duplicate, malformed or out-of-range rows and clipping at the final episode set `partial`; missing numbers are never invented.

`engagement` reads only `usergetdramameta` for the selected episode. It maps `like_sum`, `comment_sum`, `public_like_cur_media_amount` and `share_sum`; friend-only public-like counts, personal records and playback data are excluded. Only safe nonnegative integers are accepted, including zero; other values remain null. Series orchestration and aggregation belong to the tool consumer.

Native business dispatch begins synchronously in the original evaluation stack. A call has a 15-second Promise deadline; a two-call operation has a 35-second RPC deadline. These deadlines cannot cancel a native call already sent to WeChat. Timeout, context loss or cancellation can leave completion unknown and never authorize automatic replay. Operations do not unlock episodes, launch advertisements or change user state.

Raw `{publicResult, privateResult}` values stay inside the trusted helper. `call_operation` returns only validated public metadata. First-episode acquisition additionally requires a prevalidated private media consumer, a fresh free-first-episode check, exact native serial number 1 and `is_straight`. The consumer receives the HTTPS address with its exact source binding, persists a private receipt before transfer, and never returns that address to the model. The persistent host owns storage, download, decoding and cleanup; registration does not enable those capabilities by itself. Arbitrary episodes request their actual serial number and require the matching native `is_straight` response; the first-episode free flag does not authorize other episodes. Their private bindings use the actual serial number and `playAuthorization: native-straight-playback`.

The helper accepts `download_episode` and `download_status` with `{srcAppId,dramaId,episodeNo,idempotencyKey}`; the key is exactly 64 lowercase hexadecimal characters and never reaches the native expression. It persists the source and key before address acquisition. Status reconciles the original directory without a native request: `request-not-found`, `resume-available`, `outcome-unconfirmed`, or verified `download-returned`. A recorded provider rejection remains that rejection. Unknown acquisition never causes automatic replay. Completed media are stored as `downloads/<key>/media/episode-NNNN.mp4`, with at least four decimal digits.

Transfer retries reuse the encrypted address. Range continuation requires the same URL hash, a verified durable prefix, original length, matching ETag or Last-Modified, and exact HTTP 206 Content-Range. Changed resources, missing validators and ignored ranges stop without appending. Complete checkpoints can be decoded again without another HTTP request. Successful files require metadata, full decoding and SHA256 checks; a publication receipt allows recovery after the final file was written but before the transfer state was recorded. A completed transfer failure retains the original address for retry. Unconfirmed media-child cleanup returns `media-process-cleanup-failed` and prevents that key from resuming; it never becomes an ordinary retry.

Offline tests use synthetic wrappers and the real socket-free RPC/Protobuf implementation. They do not evaluate extracted target source or qualify a new Windows deployment.
