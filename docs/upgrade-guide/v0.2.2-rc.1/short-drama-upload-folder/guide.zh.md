---
kind: upgrade-guide
description: "短剧上传目录附件须有已归档的单集候选。"
---

# 先归档短剧上传目录附件

[English](guide.md) | 中文

## 变更

Desktop 编辑与创作会话在 `present`、`send_file`、`dsh_im_return_file` 中检查已绑定短剧项目的 `00-交付上传` 视频，也检查与已标记 `short-drama` 制作根并列的 `视频/第N集/00-交付上传`。同集已归档原片及其证据仍有效且两个视频摘要一致时，复制品可以通过；未经验证或有变化的复制品会被拒绝。修复预览和原始素材保持原行为。

## 迁移

1. 按[渲染器证据要求](../../../../packages/drama/tool-episode-render/README.zh.md)准备并渲染实际单集；保留源视频，另行核对内容和声音。
2. 使用相同时间线和显示 SRT 保存可编辑草稿，再以实际视频、时间线、字幕和草稿调用 `drama_render method=stage_delivery`。
3. 附上返回的 `01_可交付视频/第NN集.mp4`。归档文件所在分集目录旁的上传副本会与它核对。`short-drama` 外部上传目录的自动查找只使用 `short-drama/视频/第NN集`；归档在其他位置时，请附上返回的归档路径。`candidate` 状态不代表内容或剪映显示已验收。

这些检查不拦截任意 shell 复制或 Markdown 链接，也不识别所有可能的项目布局。
