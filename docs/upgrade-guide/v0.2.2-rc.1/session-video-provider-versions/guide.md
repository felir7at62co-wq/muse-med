---
kind: upgrade-guide
description: "Provider video detection now returns the downloaded content version."
---

# Provider video detection returns a content version

English | [中文](guide.zh.md)

## Change

The `sessionVideo.detect` result previously repeated a provider URL version after downloading the video. A ready result now identifies the downloaded content and can differ from the requested `remote-only` version. Playback addresses for previously cached provider versions are no longer valid.

## Migration

1. After detecting a `remote-only` source, call `sessionVideo.list` again and pair the result only with a local source whose `version` equals the result's `sourceVersion`.
2. If the local source is unavailable or its version differs, refresh the inventory and detect again. Confirm that playback and detected shots use the same version.
