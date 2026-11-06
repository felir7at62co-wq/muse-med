---
kind: upgrade-guide
description: "New storyboard audio edits require a persistent filename and reject empty or conflicting prompt labels."
---

# Storyboard audio names and prepared edits

English | [中文](guide.zh.md)

## Change

`jubian_storyboard audio_preview` now requires each new audio reference to have a nonempty `fileName` or `materialName`. It fills a missing or blank filename from the display name before freezing the preview. Model configuration retains `materialName`; audio relationship rows use `fileName`. This prevents a missing relationship display-name field from being mistaken for a lost audio binding while preserving strict filename, URL, key and order checks.

New audio edits reject empty prompt labels and conflicting labels for the same key. Existing cards and prepared files are not rewritten. Already claimed keys continue read-only reconciliation, including previews whose older expected fields still produce `readback_mismatch`; unclaimed older previews whose request changes under the new normalization must be recreated.

## Migration

1. In each new `audio_references` row, supply a nonempty `fileName`; a nonempty `materialName` remains accepted when the filename is missing or blank. Preserve the correct audio URL, key and order.
2. Replace empty labels such as `@[](voice-key)` with the intended speaker or voice name. Keep repeated references to one key identically labeled and preserve the first-use key order.
3. For an unclaimed older preview that is rejected as changed, call `audio_preview` again and use its returned `preview_path`, fingerprint and matching key. Do not modify the frozen file. For a claimed or unknown save, keep the original key and inspect the saved card instead of submitting again.
4. Report binding completion only for `status=applied` with `verified_readback=true`. An accepted save with a mismatched or unavailable readback remains unverified; inspect `mismatched_fields` and follow `next`. After a verified edit, prepare the video again and check the actual generated voices separately.
