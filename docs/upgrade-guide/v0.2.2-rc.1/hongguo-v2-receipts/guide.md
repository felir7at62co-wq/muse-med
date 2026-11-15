---
kind: upgrade-guide
description: "Hongguo v2 downloads use distinct receipts and nullable original-transfer fields."
---

# Hongguo v2 download receipts

English | [中文](guide.zh.md)

## Change

Consumers that opt into `muse-hongguo-download` with `legacyBackend: v2` receive `origin: engine-output`. The original engine produces a decoded file, so `sourceBytes`, `sourceSha256`, and `encryptedSource` are `null`; the downloader cannot independently establish those original-transfer facts. Final `bytes`, `sha256`, and `fullDecodeChecked` still describe the verified local MP4. Existing v1 configuration and receipts retain their meaning.

V2 checkpoints use a separate version and runtime identity. They do not reuse v1 checkpoints or publish an incomplete series as complete.

## Migration

1. Prepare the local runtime and private device state using the [plugin instructions](../../../../third_party/plugins/muse-hongguo-download/README.md). Set `legacyBackend: v2`, `v2RuntimeDir`, and `v2StateDir` together. A missing or invalid runtime fails explicitly; the downloader does not switch to another source.
2. In receipt consumers, use final `bytes` and `sha256` for local-file verification. Accept nullable original-transfer fields when `origin` is `engine-output`; do not replace unknown values with zero or infer whether the source was encrypted.
3. Download a selected episode and verify its path, final hash, and `fullDecodeChecked`. For a full-series request, also require `complete: true` and matching declared and downloaded episode counts. Preserve older receipts and verified videos until their normal retention policy permits removal.
