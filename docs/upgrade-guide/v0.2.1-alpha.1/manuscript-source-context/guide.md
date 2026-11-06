---
kind: upgrade-guide
description: Manuscript callers must resolve relative output paths and handle versioned review pages and source-supported notes.
---

# Manuscript source labels and review pages

English | [中文](guide.zh.md)

## Change

`manuscript_work` returns versioned `audit` directories and save receipts. `manuscriptReportMaxResultCharacters` defaults to 8000 UTF-16 units, minimum 1024, including metadata. Oversized rows expose recursive `report_item_paged` directories; scalar fields remain intact or fail. Small reports stay unchanged; group completion is not complete reading.

Declared workspace output paths and diagnostic source locations now use `./relative` with `/` separators. External paths and business text stay unchanged; durable records retain native absolute paths, and absolute inputs remain accepted.

`read_source.lines[]` adds `source_refs`/`source_line` without changing `text`. Citation `line_labels` retain speaker/voice notation, not audibility. Pages include compact neighbors; `citation_labels` omit them. `bridge_ranges` gives source path, hash and bounds.

Scope claims must match every citation; story time needs quotation/heading support in `time_basis`. `contextual_name` needs the term in a cited utterance and a unique registered identity matching its literal speaker. Unsupported notes enter `relationships_needing_recheck`, excluded from recovery. Attribution proves neither referent nor addressee/hearing.

`explained_change` requires explanation evidence and `explanation_kind: explicit_change`; unsupported older notes enter `comparisons_needing_recheck`. Plans, conditional rewards, compatible arithmetic and prevented dangers do not prove completed events. Treat explicitly effective appointments/pay standards as changes; missing payment evidence concerns receipt, not the standard. Keep source kinship terms in final summaries. Genuine bound-task requests recover from retained logs; summaries and fork prefixes cannot supply new user requests.

`source_cues` lists complete △ lines with line numbers, citation labels, paths and hashes: navigation, not temporal/event verdicts or reading receipts. Reread whole scenes before conclusions.

When the report exceeds budget, relationship/comparison receipts prioritize complete `record_review` and `record_review_notice`. If that receipt cannot fit, `record_review_omitted: true` leaves review to `audit`, without clipping. Correct notes with same-ID saves. Persistence schemas are unchanged.

## Migration

1. Resolve relative output paths against the Session cwd. Follow every `report_sections[].request` and `continuation` recursively to `null`; combine summaries with complete child collections. Carry `report_sha256`, returned `report_section` and 1-based `report_offset`. Files, notes, progress or configuration changes invalidate cursors. Follow `next_request` on `report_pending`, including receipts containing `record_review`.
2. Quote only `lines[].text`; accept nullable `line_labels` fields and use source scene labels or `source_scene_id`. `speech_column` counts complete-line Unicode code points from 1. Locate passages with `source_cues`, then read their scenes.
3. Correct flagged notes using original IDs and current evidence. Register exact speaker names or explicit aliases. If the speaker remains ambiguous, omit `contextual_name` and keep an uncertain ordinary relationship.
4. Source pages share `sourceReadMaxResultCharacters` (8000 UTF-16 units, minimum 1024); unfit minimum pages fail without coverage. Before numerical conclusions, reread endpoints and `bridge_ranges`; rules use `possible_change`, missing conditions remain unresolved.
5. Preserve question IDs and corrections. Requests beyond `manuscriptTaskRequestChars` (16000 UTF-16 units, minimum 1024) use `task_request`, `request_sha256`, `offset` and `column`, sharing the source-page budget. User changes/rebinding invalidate cursors; preserve logs instead of rebinding for recovery. [README](../../../../apps/desktop-host/README.md) details fields and limits.
