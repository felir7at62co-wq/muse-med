---
kind: upgrade-guide
description: The read tool returns versioned Unicode continuations instead of discarding long-line tails.
---

# Versioned read continuation

English | [中文](guide.zh.md)

## Change

The `read` tool returns verbatim line fragments instead of appending a truncation suffix to long lines. Its canonical result adds required `column` and `version` fields and optional `continuation: {offset, column}` when text remains. Requests accept `column` and `expected_version`. Columns and `readMaxLineLength` count Unicode code points, not UTF-16 units or grapheme clusters. Custom result validators, tool clients and output parsers must accept these fields and the revised continuation footer.

The configured caps remain in effect: defaults are 2,000 lines, 2,000 code points per line fragment and 51,200 UTF-8 bytes for fragments and separating newlines. A partial last line does not report EOF. Complete-file model-facing text remains unchanged. Previously saved read metadata remains readable; this change requires no Session-log rewrite.

## Migration

1. Update custom `read` request and result definitions to the fields documented in the [filesystem tools README](../../../../packages/fs/tool-fs/README.md). Keep `lines[].number` and `lines[].text`; do not treat a returned fragment as an entire physical line.
2. Continue with the exact returned `continuation.offset`, `continuation.column` and prior `version` as `expected_version`. Stop only when continuation is absent. On `FS_STALE_VERSION`, restart from line 1, column 1 against the current file; do not combine pages from different versions.
3. Remove checks for `... (line truncated to ... chars)` and old pagination-footer wording. Retain deployment caps. A byte budget unable to fit the next Unicode code point returns `FS_TOO_LARGE` rather than a cursor that cannot advance; configure enough bytes for a complete code point.
4. Confirm that successive reads reconstruct a long line exactly, including text after column 2,000 and emoji split across streaming chunks. Confirm that a changed file refuses the old version. Reaching EOF on the final page alone does not establish that earlier pages were read.
