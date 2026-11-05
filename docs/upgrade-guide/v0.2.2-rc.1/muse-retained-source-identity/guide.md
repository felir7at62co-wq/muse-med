---
kind: upgrade-guide
description: "Retained Muse Desktop packages require separate verified Muse and DSH Core versions before publication."
---

# Retained Muse package identity

English | [中文](guide.zh.md)

## Change

Muse has its own product version. Retained Desktop manifests now use `schemaVersion: 2`: `source.productVersion` comes from `apps/desktop/muse-product.json`, while `source.dshVersion` comes from the same source tree's root `package.json`. The Desktop package's Core version must match that root version. Completed package records retain their separate `version` and `dshVersion` fields.

The uploader validates both original versions, including when today's checkout has advanced. It refuses v1 retained manifests and v2 records missing an exact Core version. It never infers an old package's Core version from the current checkout. Existing attempts, installers, Session logs and private profiles are not rewritten.

## Migration

1. Keep the original retained attempt directory under the configured `DSH_DESKTOP_RELEASES_DIR` and its `manifest.json`, artifacts, checksums and completion record. Do not edit an attempt to bypass validation or replace its files.
2. Prefer rebuilding from the intended verified source revision. CI retention reads `apps/desktop/muse-product.json`, root `package.json` and `apps/desktop/package.json`, then writes a new immutable v2 attempt. Muse product version and Core version are independent; the two Core package manifests must agree.
3. To reconstruct an older attempt, first recover its verified source archive or commit and independently checked package completion record. Establish the Muse version from that archive's `muse-product.json` and the Core version from its root and Desktop package manifests; confirm the recorded package's `dshVersion`, artifact hashes and source revision match. Retain the reconstructed v2 inventory under a separate recovery `DSH_DESKTOP_RELEASES_DIR`, keeping the original run ID, attempt, verified source values and artifact files. Preserve the original v1 releases root; do not invent a packaging run or overwrite its attempt. If any evidence is missing or inconsistent, rebuild; do not guess a Core version.
4. Run `pnpm exec tsx apps/desktop/scripts/publish-desktop-ci.ts --check` with the routed new attempt and existing machine configuration; this verifies retained files and previews publication. Confirm `source.productVersion`, `source.dshVersion`, the completion record and artifact checksums agree before approving upload. Successful verification or preview does not publish a release.
