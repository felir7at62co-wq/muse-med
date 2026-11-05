---
description: "Build and deploy the shared Muse market website using the existing account gateway."
kind: "reference"
---

# Muse market website

English | [中文](README.zh.md)

## Summary

Browse public Skill releases, preview a Skill ZIP locally and upload it as a private team draft. The website shares the [Muse market UI](../../packages/client/ui-muse-account/README.md) with Desktop; downloaded archives are imported and enabled in Muse.

## Table of Contents

- [Build and deployment](#build-and-deployment)
- [Verification](#verification)
- [Dev Note](#dev-note)

-----

<a id="build-and-deployment"></a>
## Build and deployment

This private workspace application is deployed from Vite's build output.

Run `pnpm --filter @deepseek-ai/dsh-market-web run build` from the repository root after installing workspace dependencies. The build writes `tmp/market-cloud-web/` with an absolute asset base of `/market/ui/`. Serve its HTML at `/market/` and `/market/manage`, its assets at `/market/ui/assets/` and its public configuration at `/market/ui/config.json`. The management path lists creator Skill releases. The same path with `?view=upload` opens the separate upload page, whose return action opens the release list. Public discovery also reads the original Skill collection from `/market/catalog.json` and downloads its ZIP packages through `/market/downloads/`. Keep these Skill routes available alongside the publication API. Discovery omits an original package when the returned publication results include the same archive digest. Keep `/api/market/v1/*` and `/account` on the existing authenticated gateway. This app neither reads nor constructs browser cookies. The [gateway deployment reference](../../services/muse-accounts/MARKET.md) owns private process configuration.

The public JSON contains `limits` (`archiveBytes`, `expandedBytes`, `fileCount`), `allowedPlugins`, `requestTimeoutMs` and `metadataBytes`. Values are validated before any API adapter is created. Missing or invalid configuration shows a retry action. Align archive limits and allowed plugins with the cloud policy; a local metadata preview does not admit a package on the server. Upload confirmation creates a private draft, and a retry retains its request key. Downloads verify both byte count and SHA-256 before creating a browser file.

Serve HTML and configuration without caching; cache content-hashed assets immutably. The shared browser transport sets `cache: 'no-store'` for all market API, original catalog and release download requests, bypassing stored responses and preventing browser cache writes. The page requires same-origin scripts, connections, images and fonts; prepared images, previews and bundled fonts also use `data:` or `blob:` URLs. Its component styles require inline style support. Keep object, frame and base URL restrictions in the deployment CSP. `/market/legacy` and `/market/basic` link to the preserved resource page and gateway management page when these routes are provided by the deployment.

Original Skills use their names and purposes to select Muse characters. The discovery characters support motion and respect reduced motion settings.

The discovery page reveals additional original resources as the reader approaches the end of the visible list.

<a id="verification"></a>
## Verification

`pnpm exec tsc -b apps/market-web` compiles the browser adapter for the built integration test. `pnpm exec vitest run apps/market-web/tests/api.spec.ts` verifies bounded responses, authenticated transport, archive validation and request teardown. The [gateway integration reference](../../services/muse-accounts/MARKET.md#operations) describes the built browser-to-Host test. With `DSH_SNAPSHOT=replay`, `pnpm run test:web:built apps/market-web/tests/browser.e2e.ts` builds the production website into a test-owned directory and verifies role cards, hover stability, local upload preflight, exact browser downloads and mobile layout against fixture identities. Browser downloads do not confirm installation, enablement or a model response.

Set `DSH_MARKET_PREBUILT_DIR` to an absolute build directory to run the production website checks against existing files instead of rebuilding them. The directory must contain a nonempty `index.html` and an `assets` directory; invalid input fails the check. Test cleanup preserves that directory. The PR preview workflow uses this mode to verify the artifact it uploads; the separate component preview fixture still builds into its own temporary directory.

<a id="dev-note"></a>
## Dev Note

The website uses the Chinese market dictionary with the shared Chinese vocabulary as a fallback, matching Desktop's lookup order.

When the creator selects a Skill ZIP, the preview uses its bound portrait or matches one of 50 built-in Muse characters using the Skill name, title, description and category. The browser binds the matched portrait in the uploaded ZIP so review and discovery display the same artwork. The browser excludes historical Bot catalog entries and rejects Bot previews, uploads and downloads before making a request.
