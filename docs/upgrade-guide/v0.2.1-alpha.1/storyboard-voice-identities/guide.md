---
kind: upgrade-guide
description: "Storyboard audio edits require explicit identities for shared slots and adopted phased voices instead of legacy URL-only or asset-only references."
---

# Preserve character identities when binding storyboard voices

English | [中文](guide.zh.md)

## Change

`jubian_storyboard audio_preview` and new `audio_apply` saves refuse shared-slot assets or project-adopted phased voices when their local identity fields are omitted. Previously, omitting these fields selected legacy checking and bypassed the character-period comparison. Unphased legacy references and unrelated URL-only audio remain supported. Existing claimed keys continue read-only reconciliation without another save. Session generations and existing audio assets are unchanged.

## Migration

1. Adopt the approved voice in `project_config.json` at `project_bible.characters[].voice_profiles[]` using the exact `character_id`, `voice_period_id`, `reference_audio_asset_id` and `reference_audio` URL. Use `drama_project` preview and update to preserve other project data.
2. Supply `audio_asset_id`, `character_id` and `voice_period_id` on the corresponding `audio_references` row when calling `audio_preview`. If adoption is missing, correct the local project configuration; do not remove identity fields to retry.
3. Review the returned preview and call `audio_apply` with its original fingerprint and key. Confirm `status=applied` and `verified_readback=true`; a save receipt alone is not confirmation. Refresh `prepare_video` after an audio change.
