---
kind: upgrade-guide
description: "Automatic video continuation requires original Session bindings, and its new required inbox events cannot be read by older builds."
---

# Original-Session video continuation

English | [中文](guide.zh.md)

## Change

Desktop continues a completed native video task in its original ordinary Session, with the captured chat model, reasoning effort, working directory and Workspace membership. It does not activate the archived DS Bot. A later user selection is preserved; it is not replaced to make a pending task run.

Desktop opts into `durableInboxClaims`. The new claim events distinguish queued input from input already sent to a model. A parked-notice event records automatic input removed during producer unload. These are required-on-read events within Session format 4: an older reader that does not recognize one refuses the log. Existing log generations are not rewritten, and profiles that do not enable this option retain their old event sequence. The [persistence acknowledgement](../../../persistence-changes/2026-11-10-native-generation-inbox-claims.md) describes both reader directions.

Historical watches without authenticated original bindings remain pending. Already admitted input with an uncertain outcome is retained for review rather than automatically replayed. Provider success alone does not establish content or delivery acceptance.

## Migration

1. Retain the original Session directories, video ledger, previews, receipts and `jubian/generation-watches/` under the active Harness home. Keep the original keys; do not create a new submission to repair missing recovery evidence.
2. Follow the [Workspace successor storage guide](../workspace-owned-storage/guide.md) for the first updated Desktop start. Use the updated build for these Sessions; opening an older build against their new required events is unsupported.
3. Verify that the same Session and Workspace IDs remain and that the displayed model and reasoning effort are unchanged. New native submissions record their binding automatically while the owning services are available.
4. A missing binding, replaced or archived Workspace, changed model or unknown admitted request requires review of the original records. Keep the task pending instead of substituting another conversation, restoring the old Bot or repeating a paid request.
