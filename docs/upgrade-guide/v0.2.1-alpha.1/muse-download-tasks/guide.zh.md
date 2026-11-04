---
kind: upgrade-guide
description: "持久化抖音下载需要有归属的任务服务及配套的 Desktop Host 协议。"
---
# Muse 持久下载任务

[English](guide.md) | 中文

## 变更

`muse-douyin-download` 在 Muse 私有状态目录保存进度，通过归属到 Session 的 job 执行下载。过去只提供 `agents`、`tools` 和 `subprocess` 的自定义组合，还须提供 job registry、控制器及沙箱策略服务。插件需要可写的绝对路径 `settingsHome` 保存持久任务；`publicOnly` 不会取消该要求。

Desktop Host 协议 8 增加任务持有的浏览器下载。旧 Main 进程可能忽略新的后台标记，因此不能混用协议 7 和 8。内部 `douyinBrowser` 服务仍为版本 4，另行声明 `supportsBackgroundDownload: true`；后台请求会拒绝不具备该能力的提供方。

## 迁移

1. 同时升级 Muse Desktop 应用及内置 Host。源码工作树须通过 `pnpm run dev:desktop` 重新构建；用旧应用连接新 Host 输出不会升级 Main 进程。
2. 自定义 `dsh` profile 须加载 `@deepseek-ai/dsh-jobs-local`、`@deepseek-ai/dsh-tool-jobs`、`@deepseek-ai/dsh-sandbox-policy`，或保留提供这些服务的内置 base bundle。启动器未提供 `DSH_HOME` 时，将 `muse-douyin-download.config.settingsHome` 设为 Muse 私有状态目录。
3. 现有 `douyin_download` 调用默认 `mode: wait`。使用 `mode: background` 返回已接收任务回执；将 `downloadTask.id` 传给 `douyin_download_task` 查询、取消或显式恢复。该持久 ID 与当前 `jobId`、原生传输 ID 分开。
4. 确认 `douyin_download_task` 与 Session 的 job 控制工具能看到任务。重启后任务保持中断，显式恢复后才继续；再次获取媒体前会本地核对已完成条目。需要登录或验证时，在 Muse 的工作区浏览器正常完成后恢复任务。

任务状态、资源上限和恢复行为见[插件参考](../../../../third_party/plugins/muse-douyin-download/README.zh.md)。
