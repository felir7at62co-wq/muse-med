---
kind: upgrade-guide
description: "Strict source adoption requires actual digest-bound OCR and complete observations from its owning Session instead of a standalone review JSON."
---

# Strict source reviews require actual tool evidence

English | [中文](guide.zh.md)

## Change

When `require_source_review` is active, formal rendering and staging require complete current-source OCR and actual observed video frames from the initiating Session. A review JSON alone, an old OCR result without its full artifact digest, or another Session's report cannot establish this evidence. Original files and the released Session event format are unchanged; the new private projection cache rebuilds issuance facts from existing successful tool events.

## Migration

1. Use the shipped preset. Custom creation integrations retain legacy `video_inspect` and enable `sourceReviewCompanion` for `video_source_review`; short-drama integrations keep `requireCompleteReview=true` and complete `video_inspect`. Legacy sampling and trusted receipts remain available in creation mode.
2. Run actual `video_ocr` over the whole current source at 0.5-second spacing within the deployment's range and frame limits. Keep `raw_json_path` and `raw_json_sha256` from its successful result. Partial or unknown scans remain pending.
3. Use the available complete-review tool: `scan`, then `next` and a successful image-capable model request before `observe`. Supplement missing OCR or processing points with bounded `scan.timestamps_seconds`. Save `observation_report`, `observation_report_sha256`, `observation_session_id` and `review_id` from actual completion. A repeated requested or decoded time preserves existing frames and notes.
4. Record these exact values and any grounded visible-text decisions in the selected review's `source_qa`, following the [renderer format](../../../../packages/drama/tool-episode-render/README.md). Keep original evidence for cleaned media and review the affected intervals; copying matching bytes to another file does not lend it approval.
5. Retry formal rendering or staging through the normal Muse tool. `SOURCE_QA_TOOL_PENDING` means a PTC result is still committing: finish the current `run_code` and continue in a later independent call using the existing files. Restoring the same Session can reuse its real evidence; another Session must obtain its own. Display, synchronization and final delivery checks remain separate.
