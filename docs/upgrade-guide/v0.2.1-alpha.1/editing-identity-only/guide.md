---
kind: upgrade-guide
description: Muse editing removes delegation and mandatory managed acceptance while retaining general Harness guidance.
---

# Editing tools and guidance

English | [中文](guide.zh.md)

## Change

The editing persona is `你是muse-med编辑智能体，由{{model}}驱动`. General Harness system sections, the working directory, runtime-context snapshots and matching-skill loading guidance remain available. The preset does not mount subagent, Team, workflow-agent or `screenplay_project` tools itself; inherited tools and later registrations retain normal registry visibility and guidance. The current agent checks its own work and delivers ordinary manuscripts; editing skills require managed approval only when the active mode actually provides the managed project tool. Other presets and existing project acceptance records retain their policies. Scripts, outlines and other text deliverables default to checked Word (`.docx`) files, with Markdown retained as editable source. Explicit user format choices take precedence; screenplay conversion uses the existing export tool without retranscription or rewriting. Completing transcription does not automatically ingest the screenplay into the knowledge base. Muse decides from the task, user requirements, authorization and reuse value; ingestion and wiki synthesis are not local-delivery conditions. Chosen writes still require verified readback and accurate status reporting.

## Migration

1. Start a new editing conversation in the updated application. Earlier conversations may still contain loaded delegation, managed-project or automatic-ingestion instructions.
2. Keep existing managed projects and their acceptance records. Save autonomous revisions in a new project directory outside the old project, without reusing its managed `final/` or export parameters. Continue managed acceptance in a preset that provides that capability when needed.
3. Inspect the exported request: it should contain the Muse identity and general Harness guidance, with no delegation or managed-project tools mounted by this preset. Tools contributed by a parent composition or extension remain available under normal registry rules. Confirm that file, media, skill and document tools remain available.
