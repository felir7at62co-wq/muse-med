---
description: "经已交付 Headless profile 与真实媒体解码进行免 Key 的原 key 恢复。"
kind: "reference"
---

# 原 key 视频恢复

[English](README.md) | 中文

本 authored 场景通过真实 Loader 加载生产 Jubian 插件，提供方是私有回环服务。唯一 POST 为既有的只读子任务列表；禁止生成 PUT、新意图及真实账号。原始预览和意图属于夹具输入。生产恢复工作者按原 key 对账、捕获提供方视频，再通过真实 subprocess 服务解码画面与音轨。

模型调用原生 executor 的 `jubian_storyboard(method="reconcile_video")`。夹具随后模拟明确的操作者批准和直接 MP4 交付，删除托管原片，核验离线重放、补回执、输出字节一致及 inode 保留。可变媒体放在忽略的私有 `.dsh` 测试根目录；`workspace.expected/recovery-proof.json` 保存稳定的实际结果。

解码器依次从 `MUSE_RECOVERY_TEST_FFMPEG`、`DSH_FFMPEG_PATH` 和 PATH 上的 `ffmpeg` 解析。产物验收时把首项指向已审阅的 Desktop bundled 二进制。资源缺失会失败，不会静默跳过或替换为 mock。Linux snapshot CI 已安装 FFmpeg。`platform: posix` 对应该 subprocess 验收通道，不代表 Windows 已验证。
