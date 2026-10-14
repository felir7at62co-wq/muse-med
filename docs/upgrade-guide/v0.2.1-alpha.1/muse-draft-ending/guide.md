---
kind: upgrade-guide
description: New Muse Jianying drafts add an editable ending freeze and AI disclosure track.
---

# Muse Jianying draft endings

English | [中文](guide.zh.md)

## Change

New Jianying drafts append a two-second editable freeze of the body's actual last decoded frame. They also include a separate, editable “内容由AI生成” text track at the lower right, white without an outline, covering the whole draft including its ending. Earlier drafts did not create either track. Existing drafts are not modified or replaced.

## Migration

1. Read the [draft input requirements](../../../../packages/drama/skills/skills/tweet-drama-draft-build/references/io-contract.md) and provide the original body videos; a matching PNG is not a substitute for the final video frame.
2. Set `timeline.body_end` to the end of the body. For inputs that already contain the two-second ending, this keeps the total duration unchanged rather than appending another ending.
3. Regenerate with a new `name_prefix` in the configured draft root. Confirm the ending image segment starts at `body_end`, lasts two seconds, and the separate AI text track covers the total duration.
