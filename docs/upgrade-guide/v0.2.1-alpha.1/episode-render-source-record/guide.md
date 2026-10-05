---
kind: upgrade-guide
description: Episode render verification uses an explicit source-record sidecar and check name.
---

# Episode render source record

English | [中文](guide.zh.md)

## Change

Episode rendering writes `<output>.source-record.json`. Verification reads that sidecar and reports the `output_source_record` check. The record retains the source hashes, output hash, encoder and validation results.

## Migration

Re-render existing videos to create the current sidecar before verification. Update receipt consumers to use the returned `written` paths and the `output_source_record` check name. Existing video files and their older sidecars remain untouched; the verifier reports a missing current sidecar as a warning.
