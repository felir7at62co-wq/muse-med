---
kind: upgrade-guide
description: "Muse repairs saved model choices before request assembly instead of changing an assembled provider route."
---
# Muse model repair runs before request assembly

English | [中文](guide.zh.md)

## Change

Muse previously replaced a saved direct provider with the same model on its Muse route during request preparation when the personal provider credential was missing. It now records that replacement after a successful account catalog refresh or while creating an Agent, before its first request. A request that already captured its model selection keeps that route and its normal credential errors.

The repair retains a newer provider, model, or reasoning choice. It also retains a configured personal provider and a model or explicit reasoning effort absent from the Muse catalog. Omitted reasoning effort continues to follow adapter defaults. This behavior requires no manual Session-file changes.

## Migration

1. Sign in through **Settings → MUSE Account** and refresh the account model catalog before continuing an existing conversation.
2. If the conversation still selects an unconfigured personal provider, explicitly choose the corresponding **Muse** model in the conversation model picker, or configure the personal provider credential in **Settings → Models**.
3. Confirm the picker shows the intended provider and model before retrying. An already assembled request may finish with its original credential failure; subsequent steps use the recorded selection. Existing requests are never silently replayed through another provider.
