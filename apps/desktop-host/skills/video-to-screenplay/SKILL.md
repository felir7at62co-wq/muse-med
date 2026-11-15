---
name: video-to-screenplay
description: 用户要把视频、短剧片段或已有视频转写整理成分场剧本，或在原片基础上进行已授权改编时使用。
---

# 视频转分场剧本

先读[视频转剧本方法](references/video-workflow.md)，按用户本轮目标区分忠实来源整理与已授权的作品改编，结合实际语音文字和画面材料写成正文。只有语音转写需求时使用 `audio-transcribe`，画面分析使用 `video-review`。

用户要整部或多集转写时，在收到该请求的这一轮调用 `create_goal`，写明剧名、集数范围、每轮集数（如每轮 5 集）、原片目录、项目位置，以及最后交付整剧 Word；之后由下载、转写等通知唤醒的轮次不能再建目标。格式、用词等待定问题写进每批汇报后继续，不结束本轮等回复。细则见[多集整剧转写](references/video-workflow.md#多集整剧转写)。

每集写稿前备齐四样：

1. ASR 结果及 `output_json` 的说话人分组。
2. 画面有烧录字幕时的 `video_ocr` 结果；未加载就用 `tool_search` 搜 `video_ocr`，不在 bash 里另找 OCR 程序，并按时间与 ASR 对齐。
3. 该集的完整看帧记录：`video_inspect` 先 `scan`，再用 `next` 逐批取图，实际看过后用 `observe` 逐帧记录，直到 `status` 显示 `complete`。
4. 项目人物表。

正文按 `screenplay-format` 写：每场有场次行和「人物：」行；▲行写看帧记录里实际看到的人物位置、动作、表情和关键道具，每集都要有；说话人按画面、字卡、称呼和人物表认定，不用“男主”“某人”之类占位名。忠实转写不补写原片没有的台词、动作或钩子，结尾停在原片最后的台词或动作。每集逐条写成正文，不用脚本把 ASR 批量套进模板生成剧本。

多集时把每集交给一个子代理：简报写明原片、ASR、OCR 和人物表的路径，要求先看完该集全部帧再写，以及写到哪个文件；主控负责人物表、合稿、跨集统一和交付。

交付用 `manuscript_revision delivery`，设 `source_mode: "video"`，`video_dir` 填本剧原片目录。程序逐集检查剧本格式和看帧记录，按事实生成标签，`present` 时原样使用；标签或 `video_check` 列出格式问题、没看完帧的集时，逐条改正、补看后重新登记。整剧写完后合成完整 Markdown（各集之间空一行），用 `transcript_coverage` 覆盖全部集，再用 `screenplay_export_docx` 按集顺序导出 Word（各集默认连排），登记并 `present` 这份 Word，不等用户开口要。`manuscript_revision`、`screenplay_export_docx` 未加载时用 `tool_search` 搜出来再调用；不要在 bash 里运行技能目录的 Python 脚本，也不要自己写脚本替代或模拟这些工具。标目标完成时，程序会列出仍缺的整剧 Word、看帧或覆盖率；标完成前先补齐，补不了的在收尾汇报里如实写明。

语音收据、恢复和计费沿 `audio-transcribe`，来源画面读取沿 `video-review`；本任务不因加载这些技能而改为制作成片。分场、OS/VO、版本与批注保留，以及跨集和重复核对见 `screenplay-format`，重新分集见 `muse-episode-design`。资源按技能返回的实际 `resourceBase` 定位，不猜兄弟技能目录。

保存来源、观察与作品版本，按实际核对范围交付；转写、抽帧、文字审校或 Word 导出成功都不能单独证明忠实还原了原片。汇报只写实际做过的核对，交付说明照录程序返回的逐集核对结果和各集 coverage `summary`；没跑 `video_ocr` 的集不称已按字幕校正。
