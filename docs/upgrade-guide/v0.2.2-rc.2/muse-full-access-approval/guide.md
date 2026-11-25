---
kind: upgrade-guide
description: The Muse Desktop Full access preset now prompts for operations that require approval.
---

# Restore Jingliu approval in Muse Desktop

English | [中文](guide.zh.md)

## Change

The Muse Desktop Full access preset (`danger-full-access`) previously used approval policy `never`, which automatically rejected Jingliu writes that require confirmation. Its default approval policy is now `ask`. The preset still allows writes outside the workspace. Existing sessions keep their recorded permissions, and explicit user profile settings take precedence over the new default.

## Migration

1. If your user profile's `cordis.patch.yml` explicitly sets `permission.config.presets.danger-full-access.approval` to `never`, change it to `ask` and restart Muse to enable approvals in Full access.
2. In an existing conversation that used Full access with `never`, select **Full access** in the Permissions selector or enter `/permission danger-full-access`.
3. Request a Jingliu write you intend to make and check that the approval card appears before Muse submits the operation.
