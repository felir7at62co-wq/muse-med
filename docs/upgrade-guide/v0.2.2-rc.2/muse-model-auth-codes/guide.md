---
kind: upgrade-guide
description: "Muse Desktop records specific error codes for marked gateway authentication failures previously recorded as AUTH."
---

# Muse model authentication error codes

English | [中文](guide.zh.md)

## Change

For a model request before any output, the updated Desktop records `UPSTREAM_CREDENTIAL_REJECTED` when the gateway confirms an invalid upstream API key, or `MISSING_CREDENTIAL` when the gateway rejects the Muse session. Both previously used `AUTH`. Older gateway responses without the new marker still use `AUTH`.

## Migration

1. If you filter Desktop session errors by `AUTH`, include `UPSTREAM_CREDENTIAL_REJECTED` for supplier failures and `MISSING_CREDENTIAL` for sign-in failures. Existing session logs need no migration.
2. Use the updated Desktop and gateway together. In a test environment, confirm that upstream key rejection can switch to an eligible supplier and that an expired Muse session prompts for sign-in.
