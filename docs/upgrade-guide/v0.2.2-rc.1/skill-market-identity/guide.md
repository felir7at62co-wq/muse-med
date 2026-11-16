---
kind: upgrade-guide
description: Skill cloud identity replies require the authenticated account id, and the independent market UI uses the matching public parsers.
---

# Skill market account identity and UI

English | [中文](guide.zh.md)

## Change

The Host `identity()` reply requires `accountId`, the authenticated 16-character Muse account id, alongside `publishers` and `admin`. Direct parsers reject replies without this field. For an original gateway reply containing only `publishers` and `admin`, the Host obtains `accountId` from `/api/muse.account` through the same authenticated session. It identifies the original account for an uncertain upload; it is neither a session cookie nor a publisher id. Cloud publication and publisher ids remain 32 characters; local release ids remain archive SHA-256 values.

`@deepseek-ai/dsh-client-ui-muse-market` provides independently disposable market navigation and local management. Account sign-in remains in its existing plugin. Local installation, explicit default selection and cloud publication are separate operations. The browser-safe `@deepseek-ai/dsh-muse-market/cloud-values` export shares the Host's JSON validators; Host service imports continue to use `./cloud`.

The optional `presetPortrait` manifest field retains a character asset key. Preceding cloud parsers reject portrait-bearing metadata. Calling `prepareUpload(id, presetPortrait)` for a package without a portrait creates a separate immutable archive; existing archives, default selections and Session bindings remain unchanged. Archives without the field remain valid. See the [compatibility acknowledgement](../../../persistence-changes/2026-11-14-market-preset-portrait.md#compatibility).

## Migration

1. Upgrade the cloud catalog, Host parsers and UI together before preparing or publishing portrait-bearing packages. Verify that the Host's authenticated identity reply contains the actual account id, including when it completes an original two-field gateway reply. Do not substitute a locally generated id or infer identity from a publisher title.
2. Keep each uncertain upload's original account id, request key, archive SHA and publisher. Re-signing into that same account permits an explicit retry with the original key. Another account cannot reuse the attempt. Inspect the original record before explicitly discarding a retry; discarding does not withdraw a server-side draft.
3. Add the independent UI plugin to a named profile with local storage and activation. Optional cloud uses the configured Muse Account origin. The Desktop profile mounts these rows; disabling the market UI preserves account settings. Configure all apps through named `dsh` profiles.
4. Use `./cloud-values` for browser JSON validation and id construction. Standalone deployments serve the normally built `lib/cloud-values.browser.js` as their parser asset. Keep complete JSON and archive byte budgets in force. Confirm that a stalled cloud request still allows local import, export and default changes.
