---
kind: upgrade-guide
description: New native video submissions require the original regular preview JSON file instead of a final-file symbolic link.
---

# Use regular native video preview files

English | [中文](guide.zh.md)

## Change

New `jubian_storyboard` submissions through `submit_video` or `submit_video_batch` no longer follow a symbolic link at the final preview-file entry. The preview must be a regular JSON file in the bound project's `video_tasks` directory. Earlier submissions could follow such a link. Ancestor directory aliases that resolve to the same project through `realpath` remain supported; this does not prohibit every path containing a symbolic link.

## Migration

1. For an unsubmitted preview, use the original regular JSON file at the `preview_path` returned by `prepare_video`, inside the project's `video_tasks` directory. Keep that preview's original `idempotency_key`; do not copy the preview and choose another key to bypass the file check.
2. If the original key already has a recorded intent, retain its preview and ledger record and call `jubian_storyboard(method="reconcile_video", project_dir, idempotency_key)` with that same key. This reads the existing submission without a new intent or generation PUT. Missing legacy evidence remains unresolved and does not authorize a new key or another charge.
3. Confirm the selected preview is the original regular file and the key is unchanged. For a recorded request, verify read-only reconciliation returns the existing task or an unresolved result; do not submit a new request to verify migration. See [original-key recovery](../../../../packages/jubian/tool-jubian/README.md#original-key-video-recovery).
