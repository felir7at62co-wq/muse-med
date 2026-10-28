---
kind: upgrade-guide
description: "Muse creative BGM recommendations require script quotations and a video-bound visual review."
---

# Ground production BGM recommendations in source evidence

English | [中文](guide.zh.md)

## Change

Muse creation and short-drama presets enable `requireStoryEvidence`. A story request without current script and visual-review references no longer returns production music candidates. Generic deployments retain the false default. Library browsing remains available with `selection_status: reference_only`; download and analysis methods are unchanged.

## Migration

1. Read the corresponding script segment and inspect the currently adopted source video. Save actual observations in a project JSON with `video`, `video_sha256` and `observations`; use the real file hash. Reinspect changed videos instead of updating only the hash.
2. Add `story.evidence` entries with `kind: script` and `kind: visual_review`, project-owned `file` paths and literal `quotes`. Silent scenes can quote action descriptions. Optional transcript evidence does not replace the script.
3. Retry `bgm_match`. Correct paths or real quotes named in `needs_source_evidence` or `needs_source_correction`. `evidence_matched` confirms quotations and video identity; the agent must still judge plot, dialogue meaning, observed action and exact music excerpts.
4. Keep existing approved media and prior records. Re-selection uses current evidence; source quotes are not manufactured to match an old music choice.
