---
kind: package-reference
description: "Recovery of recorded read results after session compaction."
---

# Source recovery

English | [中文](source-recovery.zh.md)

When a committed prune or summary replaces a successful ordinary `read` result, Muse can receive a bounded index of the original Session event. The index records the path and read range when available, plus hashes for recorded text blocks; it does not designate a source as authoritative or say that Muse understood it.

`source_recover` reads a named text block from an original successful `read` event in the calling Session. Its zero-based offsets and page limits count Unicode code points, and its continuation offset accounts for the serialized output budget. The result describes the recorded event and separately reports whether the original file read was complete, partial, truncated or unknown.

The original `read` may itself omit long lines or later file ranges. Recovery cannot reconstruct text absent from that event, inspect the current file, or recover shell, PTC, image or other tool output. A missing event, non-text block or over-budget locator returns an error. No semantic comparison or delivery decision is performed.

The [source plugin](src/source-recovery.ts) defines configurable notice, page, serialized-output and per-Session cache limits. The cache contains successful original events only and uses least-recently-used eviction. After restart, the index is reconstructed from recorded events; an unavailable index does not prevent the agent from continuing.
