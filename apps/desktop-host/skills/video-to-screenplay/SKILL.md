---
name: video-to-screenplay
description: 用户要把视频、短剧片段或已有视频转写整理成分场剧本，或在原片基础上进行已授权改编时使用。
---

# 视频转分场剧本

先读[视频转剧本方法](references/video-workflow.md)，按用户本轮目标区分忠实来源整理与已授权的作品改编，结合实际语音文字和画面材料写成正文。只有语音转写需求时使用 `audio-transcribe`，画面分析使用 `video-review`。

用户要整部或多集转写时，在收到该请求的这一轮调用 `create_goal`，写明剧名、集数范围、每轮集数（如每轮 5 集）、草稿交付和项目位置，按集号顺序忠实转写；之后由下载、转写等通知唤醒的轮次不能再建目标。格式、用词等待定问题写进每批汇报后继续，不结束本轮等回复。细则见[多集整剧转写](references/video-workflow.md#多集整剧转写)。

每集写稿前备齐：ASR 结果及 `output_json` 的说话人分组；画面有烧录字幕时的 `video_ocr` 结果，未加载就用 `tool_search` 搜 `video_ocr`，不在 bash 里另找 OCR 程序，并按时间与 ASR 对齐；项目人物表。忠实转写的结尾停在原片最后的台词或动作，不新写钩子台词或无画面依据的 ▲ 行。

语音收据、恢复和计费沿 `audio-transcribe`，来源画面读取沿 `video-review`；本任务不因加载这些技能而改为制作成片。分场、OS/VO、版本与批注保留，以及跨集和重复核对见 `screenplay-format`，重新分集见 `muse-episode-design`。资源按技能返回的实际 `resourceBase` 定位，不猜兄弟技能目录。

保存来源、观察与作品版本，按实际核对范围交付；转写、抽帧、文字审校或 Word 导出成功都不能单独证明忠实还原了原片。汇报只写实际做过的核对，没跑 `video_ocr` 的集不称已按字幕校正。
