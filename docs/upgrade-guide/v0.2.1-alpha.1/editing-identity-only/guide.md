---
kind: upgrade-guide
description: Muse editing replaces its automatic workflow guidance with a single model-aware identity sentence.
---

# Editing identity-only prompt

English | [中文](guide.zh.md)

## Change

The `editing` preset's complete system prompt is `你是muse-med编辑智能体，由{{model}}驱动`, with the selected model ID substituted at request time. The preset no longer supplies automatic workflow, project-registration, knowledge-base, workspace or general tool instructions as system text, and suppresses dynamic runtime-context snapshots. Its tool catalog, skill discovery and DSH's matching-skill loading instruction remain available. Managed tool validation and existing project acceptance requirements remain in effect.

## Migration

1. Start a new editing conversation in the updated application; existing conversation history can still contain previously loaded skills and instructions.
2. Request any workflow or additional instructions explicitly, or let the agent choose matching skills. Personal preset overrides that need additional system text must opt out of `persona.config.complete` before adding sections.
3. Inspect the new conversation's exported `system/message`: it must contain only the identity sentence with the selected model ID. Confirm that the tool and skill catalogs remain available.
