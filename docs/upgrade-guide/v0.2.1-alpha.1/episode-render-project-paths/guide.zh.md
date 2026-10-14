---
kind: upgrade-guide
description: "整集渲染输入与输出的相对路径改为以项目根目录解析，不再以 Host 工作目录解析。"
---

# 整集渲染路径以项目为基准

[English](guide.md) | 中文

## 变更

`drama_render` 的所有输入与输出相对路径都以 `project` 为基准，包括 `shots`、`lines`、`alignment`、`subtitle_srt`、`ending_audio`、`ending_effect` 和显式 `output`；`timeline`、`bgm`、`bgm_plan` 继续以项目为基准。绝对路径与默认项目输出位置保持不变。

后台渲染 Python 脚本采用同一规则，包括单集 `--freeze-image` 和批量 `--bgm-dir`。过去相对于调用进程工作目录的路径现在可能指向不同文件。渲染器不改变进程工作目录、编码、音频混合或二进制/字体部署配置。

## 迁移

1. 跨工具传递绝对项目根目录。相对 `project` 仍只在入口按调用进程工作目录解析一次。
2. 检查已保存的渲染调用和脚本参数。项目文件改为相对于该根目录的路径，或保留绝对路径。项目外的随包片尾素材使用 skill（技能）实际安装位置的绝对路径；字节校验仍是必需项。
3. 在不同于项目的工作目录执行 `prepare`、`subtitles`、`render` 和 `verify`，确认输入路径和写入路径指向预期项目或显式绝对目标。参见[渲染器参考](../../../../packages/drama/tool-episode-render/README.zh.md)。
