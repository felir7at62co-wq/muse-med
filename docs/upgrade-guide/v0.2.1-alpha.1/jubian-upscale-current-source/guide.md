---
kind: upgrade-guide
description: Jubian upscale requests default to the newest result and its current processed video instead of the first original file.
---

# Jubian upscale source selection

English | [中文](guide.zh.md)

## Change

`jubian_video method=upscale` reads child results in descending provider creation time, skips known unfinished or failed results, and submits the first usable result’s current video URL. It previously used the first URL-bearing result in provider order and preferred its original URL. A previously subtitle-erased version now remains the input to HD conversion. Subtitle erasure source selection is unchanged.

The bundled HD workflow chooses the newest generated result within the requested episode and package. A successful matching upscale result with a current output URL is adopted directly; frame, audio and metadata inspection run only when separately requested. Existing payment authorization and idempotency rules still apply.

## Migration

1. Start a new conversation or reload the updated background-render skill to use the new default.
2. Keep existing task IDs and idempotency keys. Reusing a recorded key returns its original outcome; it does not create a conversion of a newer result.
3. For a new authorized conversion, confirm the source task belongs to the intended episode and package. Explicit requests for an older version still require exact source selection; the default does not override them.
