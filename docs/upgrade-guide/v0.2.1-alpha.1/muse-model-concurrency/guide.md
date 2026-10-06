---
kind: upgrade-guide
description: Muse model gateways retire administrator concurrency-limit settings.
---

# Muse model relay concurrency

English | [中文](guide.zh.md)

## Change

Muse model relays no longer impose per-account or shared concurrency limits. The Desktop model route also removes its own request-frequency limiter. Gateway environment settings `MUSE_DESKTOP_MODEL_MAX_ACTIVE` and `MUSE_DESKTOP_MODEL_MAX_TOTAL` are retired; either setting stops startup with a migration instruction. Provider rate limits and model output limits still apply.

## Migration

1. Remove both retired variables from the gateway environment file and service overrides.
2. Deploy the updated files in `services/muse-accounts/` and restart the gateway.
3. Confirm parallel model requests no longer return the local “模型请求过多” error. An upstream 429 remains a provider failure and follows the client retry policy.
