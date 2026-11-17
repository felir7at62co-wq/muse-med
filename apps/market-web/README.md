---
description: "Build and serve the standalone Muse Skill market with the shared Desktop presentation and existing account gateway."
kind: reference
---

# Muse Skill market website

English | [中文](README.zh.md)

## Summary

Browse public Skills, inspect their requirements, download packages for Muse and upload a Skill ZIP as a private team draft. The website shares cards, details, characters, publication filters and guidance with the [Desktop market UI](../../packages/client/ui-muse-market/README.md). Browser downloads do not install, enable or run a Skill; import the downloaded ZIP in Muse and choose its version for new chats.

## Table of Contents

- [Build and deployment](#build-and-deployment)
- [Packages and account access](#packages-and-account-access)
- [Verification](#verification)
- [Dev Note](#dev-note)

-----

<a id="build-and-deployment"></a>
## Build and deployment

After installing workspace dependencies, run `pnpm --filter @deepseek-ai/dsh-market-web run build` from the repository root. Vite writes the static website to `tmp/market-cloud-web/`, using `/market/ui/` as its asset base. This private workspace application has no npm publication payload; deploy its static build to the gateway. Building prepares files; deployment is a separate operation.

Serve the same built HTML at these existing routes. The application chooses its view from the pathname and query string and supports browser history navigation.

| Route | View |
|---|---|
| `/market/` | Public Skill discovery |
| `/market/manage` | Current account's publications and moderation |
| `/market/manage?view=upload` | Separate ZIP preview and upload page |

Serve the build's content-hashed files under `/market/ui/assets/` with immutable caching. Serve HTML and deployment-owned `/market/ui/config.json` without caching. Keep configuration requests separate from the HTML fallback. Preserve `/market/catalog.json`, `/market/downloads/`, `/api/market/v1/*`, `/api/muse.account` and existing account routes on their current owners; deploying this website does not replace the gateway or its account logic.

The public configuration supplies `limits.archiveBytes`, `limits.expandedBytes`, `limits.fileCount`, `requestTimeoutMs` and `metadataBytes`. Optional `limits.recordBytes` defaults to 4 MiB; optional `catalogLimit` defaults to 100 and cannot exceed 100. The configuration contains no credentials or private storage paths. Missing or invalid configuration presents a retry action. The [transport implementation](src/transport.ts) defines accepted bounds.

<a id="packages-and-account-access"></a>
## Packages and account access

Public catalogs omit login cookies so an expired login cannot block discovery. Private publication reads, uploads, downloads requiring membership and moderation use the browser's existing same-origin Muse login and remain subject to the gateway's current permissions. The website does not read cookies or construct authentication secrets. Account changes invalidate private results and prevent an upload retry from switching to another account.

Selecting a ZIP only previews it locally. The preview validates the complete package and uses its saved character, or automatically assigns an unbound character with the same matcher as Desktop. Confirmation uploads those prepared bytes as a private draft. Retries retain the original file, account, team and request key. Submission for review and approval are separate actions; uploading never publishes automatically.

Published packages are downloaded only after their byte count, digest and manifest have been verified. Original Skills from `/market/catalog.json` are verified against their listed ZIP digests, then converted in the browser into canonical Muse packages before download. This conversion leaves the original catalog and ZIP files unchanged. The downloaded package can be imported directly in the current Muse market; installation and default selection remain explicit Desktop actions.

<a id="verification"></a>
## Verification

The [adapter tests](tests/api.spec.ts) cover same-origin requests, public configuration limits, account identity changes, archive validation, character binding and verified downloads. The shared UI's [browser tests](../../packages/client/ui-muse-market/tests/browser.client.spec.tsx) cover independent catalog failures, progressive loading, private visibility and retained upload attempts. These checks do not replace production login, publication or model-run acceptance.

<a id="dev-note"></a>
## Dev Note

The current website uses the shared Chinese dictionary. Its theme control supports light and dark presentation. This application does not start a local Host or maintain a second installation inventory.
