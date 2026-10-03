# 短剧渲染文件捕获设计

[English](2026-09-21-drama-render-file-capture-design.md) | 中文

## 问题

`drama_render prepare` 无法在 DSH Windows 运行时中探测有效媒体，因为 `createSpawnChannel` 通过 Node 管道捕获子进程 stdout/stderr，而该运行时以 EPERM 拒绝使用管道的子进程 stdio。独立 FFprobe 已确认媒体有效。

## 已批准的方案

保持现有 `ProcessChannel` 约定与全部 FFmpeg 解析不变。加入适用于 Windows 的通道，将 stdout/stderr 重定向到唯一临时文件，在进程退出后读取并删除文件。让 `createMediaToolkit` 默认使用该通道，保留注入通道与现有错误语义。

## 验收条件

- 捕获真实子进程 stdout 和 stderr，不使用 `stdio: pipe`。
- 非零退出保留 stderr 与退出码。
- 可执行文件缺失时报告错误码 127。
- 成功和失败时均删除临时文件。
- 现有渲染器测试通过。
- `drama_render prepare` 成功探测项目媒体。
