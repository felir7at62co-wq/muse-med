---
kind: upgrade-guide
description: Jingliu uses Muse sign-in for existing workbench accounts.
---

# Connect workbench accounts to Muse

English | [中文](guide.zh.md)

## Change

Jingliu uses Muse sign-in. The Jingliu chat tools use the active Desktop account. Existing projects, manuscript owners, permissions and balances refer to the applications’ numeric user IDs.

## Migration

1. Register Jingliu’s fixed callback and server credential in the Muse gateway's `MUSE_WORKBENCH_LOGIN_CONFIG`. See the [gateway configuration](../../../../services/muse-accounts/README.md).
2. Configure and install the [business service adapters](../../../../services/muse-workbenches/README.md). Bind the stable Muse account ID to the verified existing workbench user ID before enabling access.
3. Configure `MUSE_JINGLIU_ORIGIN` for Desktop. Sign in with a mapped test account and open an existing Jingliu project. Check that another account cannot see the first user's private work.
