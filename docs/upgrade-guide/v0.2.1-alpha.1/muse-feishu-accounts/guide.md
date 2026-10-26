---
kind: upgrade-guide
description: Muse account writes use a new account-file version that older gateways cannot read.
---

# Muse account storage

English | [中文](guide.zh.md)

## Change

The Muse account gateway reads account-file versions 1 and 2 and writes version 2 on its first account mutation, including desktop registration and activity reporting. Version 2 supports Feishu-only accounts without a password and retains existing account IDs, password hashes, administrator roles, revisions and device records. Older gateways reject version 2.

## Migration

1. Stop the old gateway and back up `MUSE_ACCOUNTS_FILE` together with `MUSE_SESSIONS_FILE` before starting the new writer. Keep durable data outside release directories and run one writer.
2. Start a gateway compatible with version 2. Existing password accounts remain usable; bind the administrator's Feishu identity from the authenticated existing account. New Feishu identities create ordinary accounts.
3. Configure the custom app and private file described in the [gateway reference](../../../../services/muse-accounts/README.md#feishu-login). Confirm an available enterprise member can sign in and Feishu rejects an unavailable member.
4. Verify `/api/muse.account` preserves the existing administrator role and `/admin` shows the linked identity. Confirm repeat login and multiple desktops do not increase the user count.
5. Roll back using a version-2-compatible gateway. Restoring the pre-upgrade account and session backup requires stopping the writer and explicitly accepting the loss of later account changes; do not edit version numbers or generate password hashes for Feishu-only accounts.
