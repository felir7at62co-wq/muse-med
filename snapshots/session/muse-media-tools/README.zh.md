# 公司媒体快照

[English](README.md) | 中文

此无密钥场景启动随包的 `headless` profile（配置组合），按需发现四个生产公司媒体工具，并使用真实的 Muse 账号传输、本地导入器和 `present` 工具。隔离的本地回环网关提供公开元数据、未完成下载、原任务的完整回执、重复提交、部分文件清单，以及 HTTP 限流与权限失败。合成登录信息保存在私有临时账号目录。

已提交的一秒 H.264 fixture（测试前置数据）通过从 `PATH` 选择的真实 FFprobe 和 FFmpeg 命令。缺少可执行文件时场景失败。完整的 `workspace.expected/` 目录树核对导入字节、固定来源回执字段和独立验证报告；只展开回执中已声明的工作目录占位符。生产 `present` 调用必须持久化 `deliverables/presented` 事件。部分任务中未列出的文件仍不可用。

从仓库根目录运行只读回放：

```sh
pnpm exec vitest run --config vitest.snapshot.config.ts snapshots/session/headless.snapshot.ts -t 'muse-media-tools|company media expected workspace'
```

如需根据已编写的模型响应收集当前生产输出，只刷新此场景并审查所有生成差异：

```sh
DSH_SNAPSHOT=refresh pnpm exec vitest run --config vitest.snapshot.config.ts snapshots/session/headless.snapshot.ts -t 'muse-media-tools'
```

此场景不调用真实模型或平台，也不读取生产登录。它验证组合后的工具、文件与交付行为；不代表真实平台可用性或 GUI 验收。
