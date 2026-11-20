---
kind: upgrade-guide
description: "Muse Desktop and the account gateway no longer hand supplier credentials to the desktop; every Muse model request goes through the gateway relay."
---

# Muse supplier-direct model access removed

English | [中文](guide.zh.md)

## Change

A gateway started with `MUSE_DESKTOP_MODEL_TRANSPORT=direct` gave each signed-in Desktop the real supplier address and key from `GET /api/desktop-models/access`. Desktop saved them in `model-access.json` beside the account `session.json` and called the supplier itself. Official Zhipu could instead hand out a short-lived token per request through `/api/desktop-models/zhipu-official/leases`, and Desktop reported the token counts of those direct calls to `POST /api/muse.account/usage`.

All of that is removed. Desktop sends every Muse model request to `/api/desktop-models/<provider>/chat/completions` on the account gateway with the signed-in session, and the gateway calls the supplier with keys that stay on the server. Desktop no longer asks for direct or leased access, ignores any supplier address or key in a catalog response, and deletes a leftover `model-access.json` at startup and on every catalog refresh. The gateway no longer serves the access, lease or usage-report routes. It refuses to start when `MUSE_DESKTOP_MODEL_TRANSPORT` is set to anything other than `relay`, or when `MUSE_ZHIPU_DIRECT_TOKEN_MS`, `MUSE_ZHIPU_DIRECT_REQUEST_MS`, `MUSE_ZHIPU_DIRECT_CHECK_MS`, `MUSE_ZHIPU_DIRECT_GRACE_MS` or `MUSE_USAGE_RATE_PER_MINUTE` is set.

Older Desktop versions keep working: when the gateway does not offer direct access they already use the relay and delete their own `model-access.json`. Usage records reported earlier with the `desktop-direct` source stay readable.

## Migration

1. Remove `MUSE_DESKTOP_MODEL_TRANSPORT=direct` and the retired `MUSE_ZHIPU_DIRECT_*` and `MUSE_USAGE_RATE_PER_MINUTE` settings from every gateway environment before deploying this version. Setting `MUSE_DESKTOP_MODEL_TRANSPORT=relay` remains valid.
2. A gateway that ever ran with `direct` sent its supplier keys to every Desktop that signed in, and copies outside the gateway stay valid until the supplier revokes them. For each such key, create a replacement at the supplier, update the gateway's model configuration with it, confirm a Muse model reply, then disable the old key. Disabling the old key first breaks the relay for everyone.
3. Delete a leftover `model-direct-leases.json` beside the gateway's account file; it holds no secrets and nothing reads it.
4. Confirm the result: a Muse model reply arrives in Desktop, and no `model-access.json` appears beside the account `session.json`.
