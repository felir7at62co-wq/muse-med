---
name: audio-transcribe
description: Use when 用户要把本地音频或视频里的语音转成文字、提取人物台词、生成带时间戳的转写，或为后续剧本整理取得忠实语音原文。
---

# 音视频语音转写

对用户提供或授权读取的本地媒体做离线语音识别。转写是可核对的语音原文，不把推测的画面、动作或剧情补进台词；若用户还要改编成剧本，保留原始转写另行创作。

## 运行

先确认输入媒体和两个新输出路径；不要把输出指向原始媒体或已有结果。在 Muse Windows 随包环境中，用随包 Python 运行：

```text
python -B "<skill-dir>/scripts/transcribe.py" --input "<音频或视频文件>" --output-txt "<时间轴.txt>" --output-json "<片段.json>" --language zh
```

`<skill-dir>` 是本文件所在目录。`--language auto` 可自动检测语种；默认 `zh`。脚本使用 `MUSE_WHISPER_MODEL_DIR` 的本地 faster-whisper 模型和 `DSH_FFMPEG_PATH` 指向的 FFmpeg；未设置后者时查找 PATH。仅在已有其他本地模型时用 `--model-dir <目录>`。不下载模型、不调用云端接口，也不修改输入媒体。

TXT 每段格式为 `[00:00:01.250 --> 00:00:03.500] 台词`；JSON 是逐段数组，字段为秒数 `start`、`end` 和 `text`。完成后读取输出并核对时间顺序、明显错词以及是否漏识别；需要人工修订时另存新文件并保留原始转写。媒体无可识别语音、缺少模型或 FFmpeg、输出路径已存在时，脚本报错且不生成空转写或覆盖已有结果。

Muse Windows 安装包提供相应 Python、模型和 FFmpeg。其他部署须自行配置本地 `faster-whisper`、模型和 FFmpeg；脚本仍只在本机运行。此技能只做语音转写，画面 OCR、场景截图和云识别不在此工具范围。
