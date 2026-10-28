---
kind: upgrade-guide
description: "Removes the automatic video reuse notice and its existingVideoAdvisory configuration option."
---

# Remove automatic video reuse advice

English | [中文](guide.zh.md)

## Change

`@deepseek-ai/dsh-tool-jubian` no longer injects a notice when a new user message matches video or audio extraction keywords. Its `existingVideoAdvisory` configuration option is removed. Existing-video source queries, pagination evidence and preparation results remain available. Saved `jubian-video-reuse` messages retain their historical content and source attribution.

## Migration

1. Remove `existingVideoAdvisory` from the tool plugin's configuration in `cordis.yml` or its patch.
2. Keep existing Session files unchanged. Query existing media with `jubian_video sources`; no automatic notice is required.
3. Confirm that a new extraction request reaches the model without a new `jubian-video-reuse` notice.
