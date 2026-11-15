---
kind: upgrade-guide
description: "Strict source adoption requires actual digest-bound OCR and complete observations from its owning Session instead of a standalone review JSON."
---

# Strict source reviews require actual tool evidence

English | [中文](guide.zh.md)

## Change

When `require_source_review` is active, formal rendering and staging require complete current-source OCR and actual observed video frames from the initiating Session. A review JSON alone, an old OCR result without its full artifact digest, or another Session's report cannot establish this evidence. OCR artifacts created before `decoded-pts-spatial-v2` must be rescanned because their sample timestamps and position grouping are unsuitable for strict source approval. Nonzero or unknown source timeline origins fail closed until OCR and visual review share a verified time basis; keep the original and review a zero-origin copy. Original files and the released Session event format are unchanged; the new private projection cache rebuilds issuance facts from existing successful tool events.

Projects with a positive `jubian_script_id` or `project_bible.schema_version: 1` require current source review, speech coverage, measured audio/video boundaries and independently checked draft tracks before `stage_delivery` writes to `01_可交付视频`. Omitting or disabling the project or timeline review flags no longer permits an unreviewed legacy candidate into that directory. These checks apply to episode subdirectories. Unmarked editing projects and working renders retain their existing behavior.

## Migration

1. Use the shipped preset. Custom creation integrations retain legacy `video_inspect` and enable `sourceReviewCompanion` for `video_source_review`; short-drama integrations keep `requireCompleteReview=true` and complete `video_inspect`. Legacy sampling and trusted receipts remain available in creation mode.
2. Run actual `video_ocr` on the complete current source at 0.5-second intervals within deployment range and frame limits. Continue from `next_start_seconds`, retaining each `raw_json_path` and `raw_json_sha256`. Put ordered references in the review `ocr` array and use `ocr_index` in each text decision. A missing range or failed sample remains pending.
3. Use the complete-review tool: `scan`, then `next` and a successful image-capable model request before `observe`. Supplement missing OCR or processing points with bounded `scan.timestamps_seconds`. Save `observation_report`, `observation_report_sha256`, `observation_session_id` and `review_id` from actual completion. A repeated requested or decoded time preserves existing frames and notes.
4. Record these exact values and any grounded visible-text decisions in the selected review's `source_qa`, following the [renderer format](../../../../packages/drama/tool-episode-render/README.md). Keep original evidence for cleaned media and review the affected intervals; copying matching bytes to another file does not lend it approval.
5. For a short-drama project, set `project_bible.delivery.require_source_review` and `project_bible.delivery.subtitle.require_speech_coverage` to `true`, then rerun `prepare`, render with `resume=true`, and regenerate the same-episode draft. Stage with the current `speech_transcripts` and any resolved `speech_decisions`. Current-algorithm complete evidence remains usable even when a legacy flag is absent or false; missing evidence cannot be waived by those flags.
6. Retry formal rendering or staging through the normal Muse tool. `SOURCE_QA_TOOL_PENDING` means a PTC result is still committing: finish the current `run_code` and continue in a later independent call using the existing files. Restoring the same Session can reuse its real current-algorithm evidence; another Session must obtain its own. Successful staging returns a candidate; it does not certify final content or editor appearance.
