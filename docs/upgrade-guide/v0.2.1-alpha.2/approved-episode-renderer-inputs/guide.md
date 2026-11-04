---
kind: upgrade-guide
description: "The approved episode renderer receives input hashes and writes to a private candidate path."
---

# Approved episode renderer inputs

English | [中文](guide.zh.md)

## Change

The bundled Desktop renderer needs no configuration change. Custom providers of `approvedEpisodeRenderer` receive an `inputHashes` field on `ApprovedEpisodeRenderer.render`. The Host passes a private candidate path as `outputPath` and publishes the verified result. The renderer no longer writes directly to the public export path.

## Migration

1. Update custom callers of `ApprovedEpisodeRenderer.render` to supply SHA-256 hashes of the project configuration, timeline, SRT, mix profile, and BGM when present. Each shot already carries its approved hash.
2. In custom providers, render from private copies checked against those hashes and write the candidate only to `outputPath`. Honor the cancellation signal during encoding.
3. Confirm that a delivery publishes one MP4 and one receipt. If the Host stops after publication but before saving the receipt, restart the Host with the same project selected and confirm that the existing MP4 gains a receipt.
