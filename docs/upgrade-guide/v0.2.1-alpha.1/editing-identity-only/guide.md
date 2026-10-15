---
kind: upgrade-guide
description: Muse editing removes delegation and mandatory managed acceptance while retaining general Harness guidance.
---

# Editing tools and guidance

English | [中文](guide.zh.md)

## Change

The editing persona is `你是muse-med编辑智能体，由{{model}}驱动`. General Harness system sections, the working directory, runtime-context snapshots and matching-skill loading guidance remain available. The preset removes subagent, Team, workflow-agent and `screenplay_project` tools, including inherited and later registrations. The current agent checks its own work and delivers ordinary manuscripts; editing skills require managed approval only when the active mode actually provides the managed project tool. Other presets and existing project acceptance records retain their policies.

## Migration

1. Start a new editing conversation in the updated application. Earlier conversations may still contain loaded delegation and managed-project instructions.
2. Keep existing managed projects and their acceptance records. Save autonomous revisions in a new project directory outside the old project, without reusing its managed `final/` or export parameters. Continue managed acceptance in a preset that provides that capability when needed.
3. Inspect the exported request: it should contain the Muse identity and general Harness guidance, but no delegation or managed-project tool schemas. Confirm that file, media, skill and document tools remain available.
