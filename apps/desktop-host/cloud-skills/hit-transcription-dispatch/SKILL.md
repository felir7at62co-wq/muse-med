---
name: hit-transcription-dispatch
description: 已停用。数据站的储备通知改由剧本管理 Bot 按技能 transcription-supervision 处理；收到旧格式的「【储备变化】」通知时用这个技能收尾。
---

# 储备转写通报（已停用）

数据站的储备通知现在发给剧本管理 Bot，由它按技能 `transcription-supervision` 监管视频转剧本生产。

收到写着「按技能 hit-transcription-dispatch 处理」的旧通知时，只在对话里记一句，不用 `im_send`，也不做别的。用户问到转写进度时，按技能 `transcription-supervision` 回答。
