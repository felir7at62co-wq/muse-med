---
kind: upgrade-guide
description: Muse removes the manuscript_work tool and its task bindings.
---

# Muse removes manuscript work bindings

English | [中文](guide.zh.md)

## Change

Muse no longer exposes `manuscript_work`, including its `bind`, scene and audit actions. Existing Session history and `.muse/manuscript-work/` records are retained but no longer choose drafts, prioritize sources or generate adopted-version notices. The `manuscript_revision` comparison tool and ordinary file tools remain available.

## Migration

1. Remove custom instructions or integrations that call `manuscript_work`. Use ordinary file tools to read the relevant source and draft files, and use `manuscript_revision` when comparing returned drafts.
2. Start a new Session and check the available tools if an integration relies on a tool list. No manual data migration is required for old Session history or manuscript-work records.
3. Remove `repeatMinCharacters` and `actionRepeatMinCharacters` from custom `manuscriptRevisions` settings. These limits belonged to the removed work tool; other comparison and video-evidence limits remain available.
