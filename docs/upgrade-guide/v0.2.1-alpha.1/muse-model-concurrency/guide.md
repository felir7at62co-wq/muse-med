---
kind: upgrade-guide
description: Muse model gateways retire administrator concurrency-limit settings.
---

# Muse model relay concurrency

English | [中文](guide.zh.md)

## Change

Muse model relays no longer impose per-account or shared concurrency limits. The Desktop model route also removes its own request-frequency limiter. Gateway environment settings `MUSE_DESKTOP_MODEL_MAX_ACTIVE` and `MUSE_DESKTOP_MODEL_MAX_TOTAL` are retired; either setting stops startup with a migration instruction. Provider rate limits and model output limits still apply. An official Zhipu credential pool now reserves the configured per-key supplier capacity across Desktop and cloud routes in one gateway process. Full capacity waits in a bounded cancellable queue; overflow or timeout returns 503 before supplier dispatch. Other processes and directly copied credentials are not coordinated by this pool. Invalid `max_tokens` or `max_completion_tokens` values now return 400 rather than being coerced to defaults.

## Migration

1. Remove both retired variables from the gateway environment file and service overrides.
2. Deploy the updated files in `services/muse-accounts/` and restart the gateway.
3. For pooled Zhipu keys, set `MUSE_ZHIPU_KEY_CONCURRENCY` to the actual per-account entitlement; its initial default is 20, not a universal supplier guarantee. Set `MUSE_ZHIPU_QUEUE_LIMIT` and `MUSE_ZHIPU_QUEUE_TIMEOUT_MS` for the deployment. Send positive integer output limits, or omit them to use the configured model default.
4. Confirm parallel model requests no longer return the local “模型请求过多” error. An upstream 429 remains a provider failure and follows the client retry policy.
