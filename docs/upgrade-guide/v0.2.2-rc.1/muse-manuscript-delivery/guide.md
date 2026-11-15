---
kind: upgrade-guide
description: "Muse screenplay delivery requires a current scoped review or an explicit draft, video workflows also bind source evidence, and custom profiles require sessionProjections."
---

# Declare the final screenplay version before delivery

English | [中文](guide.zh.md)

## Change

Previously, an existing screenplay file could be presented without identifying whether its final bytes had been reviewed. Muse writing and revision tasks now require a `manuscript_revision` delivery declaration. A `reviewed` declaration uses a consistent continuity review of the actual final file and names its checked ranges. A `draft` declaration identifies unfinished checks or known issues without requiring additional human approval. `present` accepts the returned label verbatim. Editing the file invalidates that declaration; a Markdown review does not certify an exported Word file.

Video workflows also require source review for a `reviewed` delivery. Successful `video-to-screenplay` loading or an explicit source-review call retains that requirement; omitting `source_mode` cannot bypass it. Source and text findings remain separate. Source labels cover selected draft lines, sampled frames and saved ASR within explicit video-second ranges; they do not certify the whole video, original audio, speaker identity or shared media origin.

Automatic checks recognize conventional scene headings with dramatic action or dialogue; custom formats can declare their files explicitly. Ordinary reports, translation-only and format-only tasks retain existing behavior. Comparisons and exports remain available before review. A file request without a verified delivery receipt can receive a bounded logged completion reminder; code or links are not delivery. Inline-only and explanatory requests require no file. Existing manuscript files and Session generations remain retained.

The published `manuscript-revisions` plugin now requires `sessionProjections`, including when delivery checks are disabled. Its activation awaits projection registration.

## Migration

1. Bundled Muse profiles provide the services. Custom profiles loading `@deepseek-ai/dsh-desktop-host/manuscript-revisions` must also load `@deepseek-ai/dsh-session-projection`. Independent reviews need the agent registry, presets and spawn provider described in the [Host README](../../../../apps/desktop-host/README.md).
2. Save the actual final file. For revisions, supply the selected original as `current` and a distinct final `candidate` with explicit ranges; a final-only review cannot approve revised delivery. New creation needs no invented original. For video work, call `action: source_fidelity` with a review `task` and `video_sources` identifying saved `review_id`, video-second range, `draft_lines` and `frame_ids`. Then review the affected text with `continuity`, `cross_episode` or `repetitions` as appropriate. Unchanged versions and ranges can reuse valid receipts; exported final bytes still need binding.
3. Call `action: delivery` with `candidate_paths`, `delivery_mode: reviewed`, and `source_mode: video` for video work. Unknown or unresolved checks require `delivery_mode: draft` and an explanatory `note`. Use each returned `files[].label` unchanged as its `present` description.
4. Confirm the actual `present` receipt. Changed files, source evidence or labels claiming unchecked scope must be rejected; an explicit draft remains deliverable. Keep Office `manuscriptRevisions.continuityDeliveryChecks` enabled for normal delivery; `continuityMaxDeliveryCorrections` bounds reminders.
