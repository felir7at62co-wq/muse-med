---
kind: upgrade-guide
description: Skill cloud identity replies require the authenticated account id, and the independent market UI uses the matching public parsers.
---

# Skill market account identity and UI

English | [中文](guide.zh.md)

## Change

The cloud `identity()` reply now requires `accountId`, the authenticated 16-character Muse account id, alongside `publishers` and `admin`. Parsers reject replies without this field. It identifies the original account for an uncertain upload; it is neither a session cookie nor a publisher id. Cloud publication and publisher ids remain 32 characters; local release ids remain archive SHA-256 values.

`@deepseek-ai/dsh-client-ui-muse-market` provides independently disposable market navigation and local management. Account sign-in remains in its existing plugin. Local installation, explicit default selection and cloud publication are separate operations. The browser-safe `@deepseek-ai/dsh-muse-market/cloud-values` export shares the Host's JSON validators; Host service imports continue to use `./cloud`.

## Migration

1. Upgrade the cloud catalog, Host parsers and UI together. Verify that an authenticated identity reply contains the actual account id. Old two-field identity replies refuse; do not substitute a locally generated id or infer identity from a publisher title.
2. Keep each uncertain upload's original account id, request key, archive SHA and publisher. Re-signing into that same account permits an explicit retry with the original key. Another account cannot reuse the attempt. Inspect the original record before explicitly discarding a retry; discarding does not withdraw a server-side draft.
3. Add the independent UI plugin to a named profile with local storage and activation. Optional cloud uses the configured Muse Account origin. The Desktop profile mounts these rows; disabling the market UI preserves account settings. Configure all apps through named `dsh` profiles.
4. Use `./cloud-values` for browser JSON validation and id construction. Standalone deployments serve the normally built `lib/cloud-values.browser.js` as their parser asset. Keep complete JSON and archive byte budgets in force. Confirm that a stalled cloud request still allows local import, export and default changes.
