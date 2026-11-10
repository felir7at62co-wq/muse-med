---
kind: upgrade-guide
description: "Desktop formal short-drama file delivery now requires a current staged episode candidate and matching editable draft."
---

# Stage short-drama candidates before file delivery

English | [中文](guide.zh.md)

## Change

Desktop editing and creation sessions previously allowed `present`, `send_file` and `dsh_im_return_file` to hand off a short-drama working export directly. These operations now reject registered native episode outputs and videos in bound short-drama formal output locations unless they match a current `stage_delivery` candidate. Changes to the MP4, SRT, timeline, recorded sources or original pairing evidence invalidate that candidate for these file operations. Later edits of native draft files alone do not invalidate the existing MP4. Other file tasks and raw source-clip attachments retain their behavior.

The portrait subtitle center remains at ratio `0.736747073` from the top (about 74%). The proposed 64% position is not the product default. Font size, outline, single-line formatting and source-bound timing rules retain their existing settings.

## Migration

1. Complete source OCR and actual frame observations following the [renderer evidence requirements](../../../../packages/drama/tool-episode-render/README.md). Creation sessions retain legacy sampling and provide `video_source_review` for complete observations; the short-drama preset uses complete `video_inspect`. No preset switch is required.
2. Render with `resume=true` and save the editable draft from the same timeline and display SRT under `02_剪映草稿`. Formal source QA is required regardless of project switches. Portrait outputs additionally require the current product subtitle profile and passing measured Zhuque text, width and font evidence. Landscape and square outputs retain their font rules.
3. Use `drama_render method=stage_delivery` with the actual working video, timeline, subtitle and draft paths. Keep returned `candidate` status separate from content acceptance.
4. Pass the returned `01_可交付视频/第NN集.mp4` to the file-delivery tool. After inserting clips, trimming or correcting the render SRT, rebuild affected outputs and stage again. Handoff does not approve content, editor appearance or equivalence to a subsequently edited draft. To deliver a new matching pair, stage the whole pair again.

These checks do not intercept arbitrary shell copies or Markdown links. Editable project receipts are consistency records, not signatures against intentional tampering. Outside conventional output locations, native-output registration lasts for the mounted session policy.
