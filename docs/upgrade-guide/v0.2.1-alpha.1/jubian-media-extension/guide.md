---
kind: upgrade-guide
description: Jubian media downloads now correct filename extensions that conflict with the downloaded format.
---

# Jubian media download paths

English | [中文](guide.zh.md)

## Change

`jubian_media` previously wrote bytes to the exact `output_path`, even when a provider URL ending in `.jpg` returned PNG bytes. It now replaces a missing or conflicting extension with `.png`, `.jpeg`, `.webp` or `.mp4` from the downloaded header. Compatible extensions, including JPEG `.jpg`, remain unchanged. Consumers that assume the requested filename was written must use the returned `path` instead.

## Migration

1. In callers of `jubian_media` and [`mediaMethod`](../../../../packages/jubian/tool-jubian/src/methods.ts), use the result's `path` for image reads, frame extraction and stored references.
2. Treat `output_path` as the requested basename and directory. An existing file at the corrected path can be overwritten, as with the previous exact-path write.
3. Download a PNG payload using a `.jpg` requested path and verify that the result points to a readable `.png` file. Existing files are not renamed during upgrade.
