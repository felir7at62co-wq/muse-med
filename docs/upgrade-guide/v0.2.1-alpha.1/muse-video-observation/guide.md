---
kind: upgrade-guide
description: Muse replaces caller-selected video samples with complete-episode observation and durable source-specific progress.
---

# Muse video observation

English | [中文](guide.zh.md)

## Change

Muse's unified director enables `requireCompleteReview` for `tool-video-inspect`. Its `video_inspect` interface replaces `sample`, frame counts and source intervals with whole-episode `scan`, batch `next`, per-frame `observe`, `status` and `metadata`. `video_contact_sheet` is not registered in this deployment. Unfinished scans and frame observations remain source-specific evidence gaps without restricting `screenplay_export_docx` or `present`. Delivery does not mark these observations complete. Other deployments retain their existing interface unless they enable this setting.

Progress uses new `video/review` Session events and a Host-only projection. Existing Sessions without these events have no pending reviews. A runtime that does not know the new required event refuses to read a Session containing it; retain an upgraded runtime for those Sessions. The Session envelope and writer version do not change. Optional `follow_up` state defaults to active when absent. `close` ends follow-up without changing coverage or approval; automatic source selection omits closed reviews, while explicit current-task references and existing draft bindings retain their evidence gaps.

## Migration

1. Replace custom Muse sampling instructions with `video_inspect` `scan` for the complete episode video. Detection sensitivity and batch limits belong to product configuration, not tool arguments.
2. Call `next` and record each returned `frame_id` using `observe` with visible content, changes and uncertainties. An image path or confirmation text does not establish image delivery.
3. Check `status` for the selected video's actual scan and observation progress; incomplete observations remain visible after export or presentation. Temporary interruption, an error, a topic change or restart does not close the review; continue its saved progress when needed.
4. When the Agent judges the review task has ended, call `close` with its saved `review_id` or `file_path` and optional `reason`; no additional user confirmation is required. Query `status` with `review_id` to read saved progress without opening source files. Use `reopen` to resume after its source-version check; missing or changed video keeps the review closed, and a changed video requires a new scan.
