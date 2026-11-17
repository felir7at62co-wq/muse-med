---
kind: package-reference
description: "通过不启用模型的 dsh profile 使用红果下载与任务管理库。"
---

# Hongguo command line

[English](CLI.md) | 中文

## Install

`muse-hongguo-download/cli` 导出是 Cordis 插件，不是独立可执行程序。使用 `dsh plugin --profile hongguo add /absolute/path/muse-hongguo-download-0.2.1.tgz` 将普通插件包安装到新的专用 profile，再将包内 `profiles/hongguo/cordis.patch.yml` 用作该 profile 的补丁。示例 manifest 展示 base 加插件的 bundle 列表；安装流程维护实际依赖。不要用示例覆盖已有 profile 的配置。

此 profile 不启动模型执行器、HTTP 服务、桌面账号或浏览器。在 CLI 行配置 `ffmpegExecutable`、`ffprobeExecutable`、`bytevc2Executable` 的绝对路径，或使用示例列出的环境变量。从目标工作区启动；任务记录保存在该工作区配置的任务目录内，专用 profile 仅保存稳定的本地操作员身份。

## Commands

```sh
dsh hongguo info --series 7702841940475120702
dsh hongguo download --series 7702841940475120702 --episodes 1,2 --quality 720p
dsh hongguo jobs
dsh hongguo status <task-id>
dsh hongguo pause <task-id>
dsh hongguo resume <task-id>
dsh hongguo cancel <task-id>
dsh hongguo retry <task-id>
dsh hongguo remove <task-id>
dsh hongguo merge <task-id> --series 7702841940475120702 --episodes 1,2 --mode auto --output combined.mp4
```

`info` 和 `download` 通过重复 `--series` 可以选择多部剧。省略 `--episodes` 下载完整目录；选集时输入用逗号分隔的正整数。`--quality` 支持 `1080p`、`720p`、`auto`，固定画质不会自动降低。`--output` 可以是工作区内的相对路径；外部绝对目录需要显式指定 `--permission-mode danger-full-access`，下载器仍核对真实目录并拒绝链接。默认文件权限为工作区写入。

下载、恢复和重试均在前台等待。Ctrl+C 发起取消并等待退出，保留已验证进度；CLI 不创建后台守护程序。暂停和取消绑定精确运行：可以显式传入 `--run-id`，省略时先读取任务状态。`--request-id` 可复用同一停止请求。只有执行者确认停止后才算完成，尚未确认时仍显示 pending；CLI 不会根据任务记录猜测 PID 并结束进程。

新 CLI 任务归专用 profile 的本地操作员所有。`--owner-session` 仅用于明确选择已有 Muse 会话的记录进行查看或控制，不会修改任务归属，也不会为新 CLI 任务伪造会话。应在相同的规范工作区中读取任务。移除任务记录会保留下载的视频。

## Merge

`merge` 只读取原任务中已验证的分集，不补下载缺集，也不修改任务归属。`--series` 选择一部剧；只有任务明确包含一部剧时才能省略。省略 `--episodes` 时沿用原任务选集；原任务未选集时要求完整剧集。缺少指定分集会报错，不会跳过后声称合并完成。

`--mode auto` 自动选择受支持的方法；`copy` 要求音视频流兼容，不满足安全拼接条件时报错；`compatible` 生成 H.264；所选源含音频时使用 AAC。`--output` 只能是原 checkpoint 目录中的 `.mp4` 文件名，开启完全权限也不改变此限制；省略时使用合并器的安全默认名称。已有目标和原始分集均会保留。合并在前台等待，取消及文件验证与聊天工具使用同一流程。

## Output

结果以单行 JSON 写入 stdout；自动化可以显式使用 `--json`。进度 JSON 写入 stderr。退出码：0 为成功，1 为操作失败，2 为参数错误，3 为控制请求等待确认；Ctrl+C 使用 dsh 启动器的 130。`--help` 不创建操作员记录或任务。输出不包含媒体直链、解密密钥、账号凭据或原生诊断信息。

## Verification

CLI 与 Muse 聊天工具调用同一任务和下载库。可执行路径验收必须将普通插件 tarball 安装到专用 profile，再通过构建后的 `dsh` 启动；直接导入 `cli.js` 不算应用启动验收。主分支合并、插件发布和各平台打包分别验证。
