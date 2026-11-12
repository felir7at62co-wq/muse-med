---
kind: upgrade-guide
description: "Short-drama upload-folder attachments now require a staged episode candidate."
---

# Stage short-drama upload-folder attachments

English | [中文](guide.zh.md)

## Change

Desktop editing and creation sessions check `present`, `send_file` and `dsh_im_return_file` for videos in `00-交付上传` under a bound short-drama project. They also check `视频/第N集/00-交付上传` next to a marked `short-drama` production root. A same-episode copy passes when the staged original and its evidence remain valid and both videos have the same digest; an unverified or changed copy is rejected. Repair previews and raw source clips retain their existing behavior.

## Migration

1. Prepare and render the actual episode using the [renderer evidence requirements](../../../../packages/drama/tool-episode-render/README.md); preserve source videos and independently check content and sound.
2. Save an editable draft from the same timeline and display SRT, then call `drama_render method=stage_delivery` with the actual video, timeline, subtitles and draft.
3. Attach the returned `01_可交付视频/第NN集.mp4`. A copy beside the staged file is checked against it. For an upload folder outside `short-drama`, the automatic lookup only uses `short-drama/视频/第NN集`; if the staged file is elsewhere, attach the returned staged path instead. A `candidate` result is not content or editor acceptance.

These checks do not intercept arbitrary shell copies or Markdown links, and they do not inspect every possible project layout.
