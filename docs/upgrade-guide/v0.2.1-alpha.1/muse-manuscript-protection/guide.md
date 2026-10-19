---
kind: upgrade-guide
description: Muse Desktop rejects protected manuscript exports and deliveries that overwrite user revisions.
---

# Muse returned-manuscript protection

English | [中文](guide.zh.md)

## Change

Muse Desktop's Office composition registers `manuscript_revision` globally. After a previous draft and user return are compared, Word export and delivery through `present` or `dsh_im_return_file` reject candidates that change protected user paragraphs or restore removed text. Direct `write` and `edit` calls cannot overwrite the active returned source. Previously these manuscript changes could be delivered without this comparison.

Changes to Markdown, UTF-8 text, and Word files previously presented by the same Session are detected on its next human turn. External changes have an unconfirmed author and are conservatively preserved as returned text. Renamed or reuploaded documents require explicit comparison paths. Each Session has one active manuscript comparison. IM file-return baselines record outbound queue acceptance, not successful receipt by the recipient. Protection checks normalized paragraph text and ordering, including deletion records; it does not judge story meaning. Shell writes and direct file links outside registered validation paths are not OS-locked. The system prompt and existing Session logs are unchanged.

## Migration

1. Preserve the previous draft and actual returned file. Call `manuscript_revision` with `action: "compare"`, `baseline_path`, and `revised_path` when their association is not already known. If the previous draft is unavailable, state that historical changes cannot be identified; do not manufacture a baseline from a new model output.
2. Read the returned changes. Refine unmodified passages and save a new candidate, retaining user additions and replacements and leaving removed text deleted. Use a new Session for an independent document.
3. If a protected passage needs alteration, obtain a real human message consisting of `允许修改用户改稿：` followed by its complete text, or `允许恢复用户删除：` followed by the complete removed text. Record only that change with `action: "authorize"`, its `change_id`, and the exact `authorization_quote`; ordinary polishing requests do not authorize it.
4. Run `action: "review"` with the complete `candidate_paths`. Confirm `state: "passed"`, then export and deliver those actual files. A later validation refusal requires repairing the candidate or obtaining the specific authorization, not clearing the comparison. This pass verifies paragraph preservation only.

Resource limits are explicit Office `manuscriptRevisions` settings; see the [Host reference](../../../../apps/desktop-host/README.md). Existing files require no automatic conversion, and missing baselines do not imply that the user made no changes.
