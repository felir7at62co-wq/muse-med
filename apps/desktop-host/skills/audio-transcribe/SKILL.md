---
name: audio-transcribe
description: Use when 用户要把本地音频或视频里的语音转成文字、提取人物台词、生成带时间戳的转写，或为后续剧本整理取得忠实语音原文。
---

# 音视频语音转写

对用户提供或授权读取的本地媒体，使用当前 Muse 账号的云端语音服务取得可核对的原始转写。只记录实际识别的语音，不根据画面或剧情补写对白。用户要求改编时，原始转写与创作稿分别保存。

## 项目位置

转写属于小说或剧本项目时，使用获授权的项目根目录。`source/links.md` 记录原件路径或链接、来源与实际可读状态；`source/media/` 仅存用户授权取回或复制的本项目媒体。已有媒体可原位只读，不移动或覆盖。云端任务收据保存在 `transcript/jobs/`；完成后的原始 TXT 和 JSON 按同一素材名与版本写入 `transcript/raw/`；人工听辨校订另存 `transcript/reviewed/`。只有链接、没有可读本地媒体时说明缺口，不声称已转写。

## 云端运行

先确认本地媒体和项目目录。Muse 账号必须已登录，服务器必须配置云端转写。`audio_transcribe` 的 `start` 会先检查时长，使用随包 FFmpeg 从音频或视频中提取单声道压缩 MP3，保存包含任务 ID 的本地收据，再通过当前账号提交。只上传提取的音轨，不上传整段视频。云端转写会使用计费语音服务；仅在用户要求转写、项目已有相应授权时提交。

```json
{"method":"start","project":"<项目根目录>","input":"<获授权的本地音频或视频>","language":"zh"}
```

`language` 可为 `zh` 或 `auto`，省略时为 `zh`。保存 `start` 返回的 `receipt`，然后对同一收据调用：

```json
{"method":"status","project":"<同一项目根目录>","receipt":"<start 返回的收据路径>"}
```

`processing` 或 `uncertain` 表示任务仍需查询；继续用同一收据调用 `status`。网络超时不能说明提交未被受理，不要换素材版本或任务 ID 直接再提交。服务器确认原任务不存在且本地压缩音轨仍在时，工具才用原 ID 重试。留存到期仍未解决时，网关删除临时云对象；下一次 `status` 删除本地暂存音轨，但保留收据和原任务 ID 供只读对账，不重新提交。`complete` 才有 `output_txt` 和 `output_json`；`silent` 表示未识别到语音，只保留收据，不生成空转写。未登录、服务器未部署或未配置、限额或音轨提取失败时，报告具体障碍，不假称云服务成功，也不自动切换到离线识别。

TXT 每段格式为 `[00:00:01.250 --> 00:00:03.500] 台词`；JSON 为包含秒数 `start`、`end` 和 `text` 的逐段数组。完成后读取输出，核对时间顺序、明显错词和漏识别；人工修订另存新文件，保留原始版本。

## 获得离线转写授权时

用户明确要求本地离线转写，或云服务不可用后同意改用离线转写时，才使用随包 Python 与本地 faster-whisper 模型：

```text
python -B "<skill-dir>/scripts/transcribe.py" --input "<音频或视频文件>" --output-txt "<新的时间轴.txt>" --output-json "<新的片段.json>" --language zh
```

脚本要求已有 `MUSE_WHISPER_MODEL_DIR`，并使用 `DSH_FFMPEG_PATH` 或 PATH 中的 FFmpeg；不会下载模型。两个输出路径必须是新文件，不覆盖云端或人工校订结果。此技能只做语音转写；画面 OCR 和场景截图需分别核对。
