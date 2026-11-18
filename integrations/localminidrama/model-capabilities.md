---
kind: reference
description: "Documented and configured video limits for individual Muse production packages."
---

# Model capabilities

English | [中文](model-capabilities.zh.md)

Each production package has its own prompt, requested clip duration and generation history. An episode contains ordered packages; its total duration is independent of one supplier request's limit.

For an exact Seedance 2.5 model on the official Ark origin with a Volcengine protocol, the public configuration summary includes a 4–30 second range and default 720p resolution. The adapter preserves a requested 20-second clip, accepts the supplier's `-1` automatic duration and rejects invalid explicit lengths before dispatch. First/last-frame generation uses the supplier-required adaptive ratio. These rules follow the [official task API](https://docs.volcengine.com/docs/ark/create-video-generation-task-api?lang=zh&redirect=1); configuration checks do not establish actual model access.

An opaque deployment ID has no inferred limit. Its AI configuration `settings` may explicitly contain `muse_model_capabilities: {"ep-example": {"profile": "seedance-2.5"}}`, or a per-model `max_duration_seconds` and `default_resolution`. Configured limits remain identified as configured; unknown limits remain null. Public summaries include no credential or arbitrary settings.

Video task observation stores only genuine supplier token fields under the original generation's operation, including resumed observations. Repeated polling updates the same resource usage record. Missing fields remain unknown, and persistence failure is visible without submitting another generation or discarding a finished video.
