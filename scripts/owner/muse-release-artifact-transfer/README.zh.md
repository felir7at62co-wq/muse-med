# 已验证 Muse 草稿发布产物传输

[English](README.md) | 中文

## 概述

手动[传输工作流](../../../.github/workflows/muse-desktop.yml) 将现有 Windows EXE 和 Mac ARM DMG/ZIP 文件补传到两个已确认的草稿发布。它下载成功的原生构建产物和真实安装验收记录，并在上传前检查全部原始文件字节。它不构建、安装、公开发布、删除或替换资产，也不访问 TOS。

## 目录

- [运营封存清单](#operator-seal)
- [草稿传输](#draft-transfer)
- [验证](#verification)
- [开发备注](#dev-note)

<a id="operator-seal"></a>

## 运营封存清单

最终源码 CI、两平台真实安装检查和本地发布暂存均通过后，运营人员在本 README 旁提供 `seal.json`。封存清单只包含 `schemaVersion: 1`、公开的 `repository`、稳定版 `version`、完整 `sourceCommit`、正整数 `sourceRun`、两个 `releases` 和十一个 `files`。每个发布包含正整数 `id`、精确的 `tag` 和 `prerelease` 标记，稳定版排在 RC 兼容版之前。每个文件只包含 `filename`、字节 `size` 和小写 `sha256`。严格字段检查会拒绝私有暂存路径、凭据和验收记录正文。本分支没有默认封存清单；缺少清单会阻止传输。

十一个文件的身份来自已验证的最终发布清单。运营人员先向两个草稿上传八个小资产，包括当前 Mac 更新元数据，并将稳定版和 RC 两个标签都指向确认的源码。原构建必须是在 `main` 上手动运行且成功完成的构建，恰有两个成功的原生作业和真实安装验收。原始产物必须属于该运行和源码，且尚未过期。

<a id="draft-transfer"></a>

## 草稿传输

工作流只能通过 `codex/muse-release-artifact-transfer-105` 分支的手动触发运行。它使用 Node 内置模块、GitHub CLI（命令行界面）和产物下载 action，不安装仓库依赖。工作流 token 仅保留在内存中。因为按标签查询草稿可能返回 404，元数据请求使用明确的发布 ID。凭据不会打印或写入文件。

两个原始 `unsigned-build.json`、其中列出的每个原始产物字节和两个原生验收记录都必须对应已确认的源码与版本。二进制文件的字节数及 SHA256/SHA512 必须符合原始记录，五个二进制文件还必须符合公开封存清单。每份验收记录必须通过完整安装文件对比、已安装运行时检查和原生安装器操作；其安装器 SHA256 必须对应精确的 EXE 或 DMG。

每次单文件上传前后，辅助程序都验证两个标签、草稿发布 ID、可见性、预发布标记，以及已有资产的字节数和摘要。小资产缺失或不匹配、意外资产和部分上传的资产都会阻止传输。已匹配的大资产会跳过；辅助程序仅上传缺失的 EXE、DMG 和 ZIP，不使用 `--clobber`。完成时，两个草稿各自必须恰有十一个匹配的资产。运营人员须在传输期间保持两个发布私有；GitHub 的资产上传不提供原子的草稿条件检查。发布状态变化会让下一次身份检查失败。

完整远端文件字节回读和公开发布由发布运营人员随后完成。传输成功只验证 GitHub 资产元数据并保留草稿可见性，不授权或执行公开发布。连接失败后，必须检查当前草稿再重新运行工作流。完整匹配的已上传资产会被跳过，任何不匹配仍会导致失败。

<a id="verification"></a>

## 验证

在 checkout 中运行 `node --test scripts/owner/muse-release-artifact-transfer/*.test.mjs`。所属测试使用私有临时目录和注入的 GitHub 适配器，不调用 GitHub、读取凭据或创建网络监听器。fixture（测试前置数据）覆盖源码、构建运行、作业和产物归属、发布可见性与标签、原始文件哈希与真实验收记录绑定、匹配资产跳过，以及两个草稿的完整传输。

Actions 入口拒绝本地执行、其他仓库、非手动事件和其他分支。可用 `node scripts/owner/muse-release-artifact-transfer/run.mjs --help` 查看命令帮助。提供已确认封存清单后的最终 runner 执行仍由运营人员验证。

<a id="dev-note"></a>

## 开发备注

无。
