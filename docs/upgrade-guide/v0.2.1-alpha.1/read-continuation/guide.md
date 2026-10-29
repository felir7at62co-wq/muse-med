---
kind: upgrade-guide
description: Read consumers must follow line and column continuation instead of the old truncated-line suffix.
---

# Read continuation

English | [中文](guide.zh.md)

## Change

`read` now returns a continuation cursor when a line exceeds the configured character or byte budget. Its structured result adds `continuation`; paginated reads and version anomalies add `versionBefore` and an optional `versionAfter`, and a resumed first line adds `column`. Unchanged complete reads from the start retain their existing result fields and text. A partial line no longer carries the old `line truncated to … chars` suffix. Provider version values are metadata, not content hashes or atomic snapshots.

## Migration

1. Update consumers of `read` results to follow both `continuation.offset` and `continuation.column`, using `column` as a 1-based Unicode code-point position within the first requested line. Treat a response with a continuation or an input column greater than 1 as an incomplete file read.
2. Compare the before and after provider versions across pages; a changed or unavailable version means the pages cannot establish one stable version. Preserve support for the old truncation suffix when processing recorded Sessions.
3. Verify a line longer than `readMaxLineLength` can be reassembled from successive pages, and that a byte cap too small for the next code point reports an error rather than an unchanging cursor.
