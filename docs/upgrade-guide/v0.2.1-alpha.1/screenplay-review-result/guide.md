---
kind: upgrade-guide
description: Successful V2 screenplay approvals expose a compact review receipt in tool content.
---

# Screenplay review result

English | [中文](guide.zh.md)

## Change

`screenplay_project` V2 `review approve` projects a `story-faithful-review-result-v2` receipt into tool content instead of the complete candidate and rendered screenplay. The receipt binds the candidate, review, acceptance and revision, keeping log verification valid when a large outer PTC result is truncated. PTC programs still receive the complete canonical `{revision, candidate, rendered}` value. Other reviews retain their existing content. Earlier full-candidate review logs remain supported; existing Session files need no migration.

## Migration

1. Update consumers that parse native tool content to read `review_receipt` and its bound identifiers, or call `read_candidate` for the complete version. Programs using the structured PTC return value need no change.
2. Let the C review program finish successfully before committing in a later model step. A receipt alone does not establish successful outer execution.
3. Confirm that the candidate identity matches the receipt and that a later `commit` and `export` succeed. Failed or missing outer results and mismatched receipts remain rejected.
