---
kind: upgrade-guide
description: "Custom Muse account gateway and controller implementations must provide the required details method."
---

# Custom Muse account implementations require details

English | [中文](guide.zh.md)

## Change

Custom implementations passed to `MuseAccountController` or `MuseAccountService` must implement `details` alongside the existing account operations. A gateway receives `details(cookie, request)`; a service controller receives `details(request)`. Both return `Promise<MuseAccountDetails>`. Existing implementations with only sign-in, status and sign-out operations fail TypeScript checking. The bundled gateway and controller supply this method.

`MuseAccountDetails` is a union of full personal details and relay-only `account-data-v1` measurements. Consumers must narrow `protocol` before reading profile, groups or usage pagination. The relay-only branch marks profile and membership availability explicitly and retains nullable token totals, UTC ranges and opaque cursors.

## Migration

1. Use `createMuseAccountGateway(baseUrl, requestTimeoutMs)` and `MuseAccountController` where possible. A custom gateway must read the authenticated account's `/api/muse.account/details` response using the supplied cookie, with no caller-selected account identifier.
2. Add `details(request)` to custom service controllers and test doubles using the [account types](../../../../packages/host/muse-account/src/types.ts). If `result.protocol === 'account-data-v1'`, render `availability` and relay-only `usage`, and pass `usage.nextCursor` as the next request's `cursor`; do not select all-history on this protocol. Otherwise read the full profile, groups and offset pagination. Preserve unknown token counts as `null`. Reject unauthenticated reads and responses completed after the local login changes.
3. Run the integration's TypeScript check and open **Settings → MUSE** after signing in. Confirm that the account details load and that another login's profile and usage cannot appear after switching accounts.
