---
name: muse-episode-delivery
description: 给分集上字幕、导出剪映草稿、把镜头合成成片或查询镜流远端交付时使用。
---

# 字幕、剪映草稿与成片

按集出字幕和剪映草稿只用三步，本机项目与镜流项目相同：

1. `episode_subtitles {method:"build", source, project, episodes}`；`status` 为 `waiting` 时用相同参数再调，直到不再等待。
2. 有 `needs_review` 时调 `episode_subtitles {method:"review"}` 分页取待核处，用 `show_view` 把听到的与剧本的文字给用户看，把用户的选择作为 `decisions` 传回。不要自己写台词、时间或对齐。
3. `jianying_draft {source, project, episodes, switches}`。`refused` 为 `subtitles_stale`、`subtitles_missing` 或 `subtitles_unverified` 时回到第 1 步；`music_missing` 按 BGM 步骤补配乐后再导出。

镜头重新生成、换版本或修剪后同样从第 1 步重跑，只重做变化的镜头，不手改偏移。

需要直出成片时，字幕用 `episode_subtitles` 写出的同一份 SRT，经 `drama_render` 的 prepare → render 合成，不沿用历史会话的手写 ASS、FFmpeg 命令或旧脚本；存在源画面字幕覆盖计划时使用对应 resolved SRT 与报告。Muse 短剧产品竖版新输出统一正文字幕视觉，旧项目和时间线字幕样式不覆盖该配置；横版及方形沿用现有布局规则。适用片尾按媒介和当前工具配置决定。查看 render_preview 和实际画面核对字体、大小、位置、单行、标点及片尾。只需草稿时不额外编码整集。镜流远端交付按账号目录查询 export_jianying 或 export_srt。
