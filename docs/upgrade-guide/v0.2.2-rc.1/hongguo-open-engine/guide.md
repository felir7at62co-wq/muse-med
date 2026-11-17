---
kind: upgrade-guide
description: "Hongguo download 0.2.0 replaces original-runtime configuration and removes the v2 health tool."
---

# Hongguo open-source engine

English | [中文](guide.zh.md)

## Change

The `muse-hongguo-download` package now uses the pinned jackotom engine, defaults to 1080p, and retains the catalog and download tool names. Desktop presets no longer select original v1/v2 runtime directories or their signing/license services. `hongguo_download_health` is removed. ByteVC2 is explicitly unsupported. Existing files and journals are retained; different engine or quality identities are not reused.

## Migration

1. Replace custom plugin configuration with `quality`, `ffmpegExecutable` and `ffprobeExecutable` as described in the [package README](../../../../third_party/plugins/muse-hongguo-download/README.md). Remove v2 runtime selection and signing settings; `legacyBackend: v2` now fails at load.
2. Use `hongguo_download_info` for catalog inspection. Use `hongguo_download` for actual episode validation and recovery receipts. Catalog success does not establish download success.
3. Check returned output paths, resolution validation, hashes and `complete` before treating a download as delivered. Keep old files until manually reviewed.
