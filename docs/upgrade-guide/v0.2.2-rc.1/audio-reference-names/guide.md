---
kind: upgrade-guide
description: "New storyboard audio references require a persistent name and verified readback before completion."
---

# Storyboard audio reference names

English | [中文](guide.zh.md)

## Change

`jubian_storyboard audio_preview` now requires a nonblank `fileName` or `materialName` on each new audio reference. It preserves an explicit nonblank `fileName`; otherwise it copies `materialName` into `fileName` before freezing the request. Audio relation rows persist `fileName`, while model configuration also retains a supplied `materialName`. Empty prompt labels and inconsistent labels for the same audio key are rejected. Equal display names do not merge distinct keys, URLs or group positions.

`audio_apply` reports the fields that failed readback. Only `status=applied` together with `verified_readback=true` confirms the binding. An accepted PUT alone does not confirm completion, and binding verification does not establish the generated voice's listening quality.

## Migration

1. Update audio-preview callers to supply a reviewed nonblank `fileName` or `materialName` for every reference. Keep existing keys, URLs, group order and any exact asset/character/voice-period associations.
2. Use the returned `preview_path`, fingerprint and original key for `audio_apply`. After a readback mismatch or failure, reconcile with that same preview and key; do not submit another PUT or change the key automatically.
3. Preserve existing prepared files. Already-claimed legacy previews continue GET-only reconciliation against their original snapshot, including previews without names; a matching old snapshot does not certify a newly repaired name. If an unclaimed old preview fails current naming or request-hash checks, create and review a fresh preview before applying it.
4. Confirm that actual saved relation rows retain `fileName`, model configuration retains the requested names, and the apply result is verified. Review generated audio separately.
