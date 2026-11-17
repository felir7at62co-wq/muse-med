---
kind: upgrade-guide
description: "Custom Muse account gateway and controller implementations must provide the required details method."
---

# Custom Muse account implementations require details

English | [中文](guide.zh.md)

## Change

Custom implementations passed to `MuseAccountController` or `MuseAccountService` must implement `details` alongside the existing account operations. A gateway receives `details(cookie, request)`; a service controller receives `details(request)`. Both return `Promise<MuseAccountDetails>`. Existing implementations with only sign-in, status and sign-out operations fail TypeScript checking. The bundled gateway and controller supply this method.

## Migration

1. Use `createMuseAccountGateway(baseUrl, requestTimeoutMs)` and `MuseAccountController` where possible. A custom gateway must read the authenticated account's `/api/muse.account/details` response using the supplied cookie, with no caller-selected account identifier.
2. Add `details(request)` to custom service controllers and test doubles. Return the current account's profile, groups and usage using the [account types](../../../../packages/host/muse-account/src/types.ts); preserve unknown token counts as `null`. Reject unauthenticated reads and responses completed after the local login changes.
3. Run the integration's TypeScript check and open **Settings → MUSE** after signing in. Confirm that the account details load and that another login's profile and usage cannot appear after switching accounts.
