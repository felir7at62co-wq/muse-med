---
kind: upgrade-guide
description: "Muse screenplay delivery requires a current scoped review or an explicit draft declaration, and custom manuscript profiles require sessionProjections."
---

# Declare the final screenplay version before delivery

English | [中文](guide.zh.md)

## Change

Previously, an existing screenplay file could be presented without identifying whether its final bytes had been reviewed. Muse writing and revision tasks now require a `manuscript_revision` delivery declaration. A `reviewed` declaration uses a consistent continuity review of the actual final file and names its checked ranges. A `draft` declaration identifies unfinished checks or known issues without requiring additional human approval. `present` accepts the returned label verbatim. Editing the file invalidates that declaration; a Markdown review does not certify an exported Word file.

Automatic checks recognize conventional scene headings with dramatic action or dialogue; custom formats can explicitly declare their files. Ordinary reports, translation-only tasks and format-only conversions retain their existing delivery behavior. `manuscript_revision` comparisons and exports remain available before review. Existing manuscript files and Session generations are retained.

The published `manuscript-revisions` plugin now requires `sessionProjections`, including when delivery checks are disabled. Its activation awaits projection registration.

## Migration

1. Bundled Muse profiles already provide the required services. Custom profiles loading `@deepseek-ai/dsh-desktop-host/manuscript-revisions` must also load `@deepseek-ai/dsh-session-projection`. Isolated continuity review additionally needs the agent registry, agent presets and spawn provider described in the [Host README](../../../../apps/desktop-host/README.md).
2. For revised screenplays, save the final delivery file and call `manuscript_revision` with `action: continuity` and explicit materials and ranges. Then call `action: delivery`, `candidate_paths` and `delivery_mode: reviewed`; alternatively use `delivery_mode: draft` with `note` explaining unresolved checks. Use each returned `files[].label` unchanged as the corresponding `present` description.
3. Confirm that changed files and labels claiming unchecked ranges are rejected, while an explicit draft can be presented. Configure the Office `manuscriptRevisions.continuityDeliveryChecks` flag only when intentionally disabling this delivery policy; `continuityMaxDeliveryCorrections` bounds completion reminders.
