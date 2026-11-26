---
kind: upgrade-guide
description: "Jubian HTTP 403 now reports access denial rather than expired authentication."
---

# Distinguish Jubian access and login failures

English | [中文](guide.zh.md)

## Change

`@deepseek-ai/dsh-jubian` now classifies HTTP 403 as `PERMISSION_DENIED`, matching application-envelope 403. HTTP or envelope 401 remains `AUTHENTICATION_REQUIRED`. Local credential failures retain that code but distinguish missing configuration, invalid format and credential-provider failure through package-authored details. No credential is cleared and no failed request is retried.

`jubian_catalog` adds `method: auth`: one read-only, free project-list request using Muse's current credential. It discards project contents and records a typed error or read-access confirmation. It does not validate project-specific permission or generation. Settings showing configured, or signing in on the Jubian website, does not establish a refreshed Muse credential.

## Migration

1. Update consumers that previously treated HTTP 403 as expired authentication to handle `PERMISSION_DENIED` as access denial. Do not repeatedly request sign-in solely from that response.
2. For a renewed login, update the credential through Muse's Jubian settings, then call `jubian_catalog` with `{"method":"auth"}`. The next call resolves the updated value without a restart. Check the Settings credential source if it is read-only.
3. Confirm the check reports `read_access_confirmed`, or retain its authentication/access/network/response error. An access confirmation does not authorize or submit paid work. See the [tool package](../../../../packages/jubian/tool-jubian/README.md) for the check's scope.
