---
kind: upgrade-guide
description: "Jianying draft requests refuse an SRT without a clock receipt unless they declare subtitle_source: manual."
---

# Jianying drafts require a subtitle clock receipt or `subtitle_source: "manual"`

English | [中文](guide.zh.md)

## Change

`jianying_draft` request files, and the `generate_draft_request.py` and `windows_aa_draft.py` generators behind them, used to accept a `subtitle_srt` without an adjacent `.clock.json` receipt and skip the subtitle check. They now refuse such a request unless it declares `"subtitle_source": "manual"`. Any other `subtitle_source` value is refused.

Generated subtitles keep working: version 1 receipts are still accepted, and the new version 2 receipt adds per-shot rows. When a version 2 receipt no longer matches the media or cuts, the error names the changed shots and the generator's JSON result carries `changed_shots`. A manual declaration does not skip a receipt that exists.

Agents and scripts that write draft requests for hand-made or imported SRTs are affected.

## Migration

1. For a subtitle produced by `episode_subtitles` or `drama_render subtitles`, keep its `.clock.json` next to the SRT; no request change is needed.
2. For a hand-made or imported SRT, add `"subtitle_source": "manual"` to the request JSON.
3. Confirm by running the request: a missing receipt without the declaration fails with `缺少时钟回执`, and the declared request builds the draft as before.
