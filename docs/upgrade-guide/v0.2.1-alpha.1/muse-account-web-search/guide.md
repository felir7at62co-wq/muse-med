---
kind: upgrade-guide
description: Muse Desktop web searches use its signed-in account gateway instead of a locally configured search provider.
---

# Muse account-authorized web search

English | [中文](guide.zh.md)

## Change

Muse Desktop selects `searchProvider: muse` and enables `webSearch: true` in its product patch. The existing `web_search` tool uses the saved Muse session to call `/api/web/search` on the account gateway. Official search keys remain on the server; the client neither receives them nor requires a local `DEEPSEEK_API_KEY`. Searches require Muse sign-in and a gateway providing this endpoint. Earlier clients do not acquire this provider through a server-only update.

Custom profiles retain their configured search providers because `webSearch` defaults to `false`. Page fetching keeps `fetchProvider: http`; model routes, the default model and the 1M model capacity with its 475k estimated working budget remain unchanged. See the [account search reference](../../../../packages/host/muse-account/README.md) for deadlines, source validation and failure behavior.

## Migration

1. Deploy the account gateway's authenticated `POST /api/web/search` endpoint before installing the Muse client update. Keep its official key in server-private configuration. Do not add a search key to client settings or model credentials.
2. Install the updated Muse Desktop Host and sign in to Muse. Its [product patch](../../../../apps/desktop-host/config/desktop.cordis.patch.yml) selects the provider. Custom profiles that opt in must also load the web service, set `webSearch: true` on `muse-account`, and select `searchProvider: muse` without replacing their fetch provider.
3. Run the [keyless search scenario](../../../../snapshots/session/muse-web-search-account-proxy/snapshot.yml) to verify source mapping and expired-session handling without paid requests. In a live environment, search success additionally requires a configured server, a valid Muse session and available upstream service; this guide does not establish those deployment conditions.
4. To restore a previous search provider, disable `webSearch`, restore that profile's `searchProvider`, and reload the Host. The previous provider may require its own credentials. No database or Session-log restoration is required; existing source results remain valid.
