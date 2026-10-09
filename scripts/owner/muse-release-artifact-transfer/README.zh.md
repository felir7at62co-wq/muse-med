# Muse 已验证产物转运与完整读回

[English](README.md) | 中文

## 概述

人工[转运工作流](../../../.github/workflows/muse-desktop.yml)为两个已确认的草稿补传现有 Windows EXE 与 Mac ARM DMG/ZIP，再完整读取两个 release 的全部远端字节。另一项公开读回操作在发布后验证相同十一文件。它不构建、安装、发布、删除、替换资产或访问 TOS。

## 目录

- [运营封存清单](#operator-seal)
- [草稿转运](#draft-transfer)
- [完整读回](#complete-readback)
- [验证](#verification)
- [开发说明](#dev-note)

<a id="operator-seal"></a>

## 运营封存清单

运营者在最终源码 CI、两平台真实安装验收与本地发布暂存通过后，将 `seal.json` 放到本说明旁。清单只包含 `schemaVersion: 1`、公开 `repository`、稳定 `version`、完整 `sourceCommit`、正整数 `sourceRun`、两个 `releases` 和十一项 `files`。每个 release 只含正整数 `id`、准确 `tag` 和 `prerelease`；稳定版先于 RC 兼容入口。每个文件只含 `filename`、字节 `size` 和小写 `sha256`。严格字段校验拒绝私有路径、凭据与报告正文；缺少清单时不能执行。

仓库引用检查只允许这份有效 JSON 输入中唯一的小写 40 位 `sourceCommit` 声明行。其他提交引用、无效输入、不同路径及组织 URL 仍然拒绝。

十一项身份来自已验证的最终发布 inventory。运营者先在两个草稿预加载八个小文件，包括 ZIP 在前且含同批 ARM DMG 的 Mac metadata。稳定与 RC tag 都指向确认的源码。源 run 必须是 main 上已完成且成功的人工构建，两个原生作业及真实安装验收都成功；原 artifact 必须属于此 run 与源码且未过期。

<a id="draft-transfer"></a>

## 草稿转运

人工 dispatch `codex/muse-release-artifact-transfer-105` 并选择 `operation=transfer`；只有此分支与仓库能够执行。工作流下载两个原始产物与两份真实安装报告。小型 owner 包将 `builder-util-runtime` 与 `semver` 锁定到 updater 同版本，校验 registry integrity 并禁用生命周期脚本；不安装仓库 workspace 依赖。工作流 token 仅驻留内存；明确 release ID 避免 draft 按 tag 查询返回 404。

两份原 `unsigned-build.json`、全部原产物字节与原生安装报告都必须匹配源码和版本。字节数及 SHA256/SHA512 与记录相同；五个二进制还需匹配清单。每份报告须通过完整已安装文件比较、runtime 检查与真实安装操作，installer SHA256 必须对应本次 EXE 或 DMG。可选打包诊断文件 `builder-debug.yml` 必须是普通文件；工具不读取正文、不纳入记录或封存清单，也不发布它。诊断目录、符号链接及任何其他额外文件名均拒绝。

每次上传前后都检查两个 tag、草稿 ID、可见性、prerelease、已有大小与 digest。小文件缺失或不符、未知资产与不完整上传都会停止。已匹配二进制跳过；只上传缺失的 EXE、DMG 和 ZIP，不用 `--clobber`。两个草稿各十一资产齐全后还须完整读取远端字节。整个过程中保持草稿私有；GitHub 没有上传时的原子草稿条件，外部变更会令下一次检查失败。

<a id="complete-readback"></a>

## 完整读回

草稿读回流式读取两个确认 release 各十一资产，核验准确字节数和 SHA256。只有固定 GitHub asset API 的首个请求带认证；跳转为人工处理且绝不转发 token。只允许 HTTPS、两个 GitHub asset CDN 主机或该资产准确公开地址；跳转数、字节大小与时间都有上界。HTTP 失败、内容不足、过长或 digest 不符均失败。

运营者公开两个 release 后，再人工 dispatch `operation=public-readback`。此操作不下载原始构建 artifact，不调用上传；所有资产匿名下载。它检查两个准确 tag 提交、公开 ID、prerelease 和十一资产、GitHub Latest 选中稳定版，以及 Atom 选中同一源码的当前 App 入口之一。Atom 使用 updater 实际 XML parser，并按旧 `rc` 频道的真实选择方式跳过 stable、alpha 与 beta；首个合法 rc tag 必须为本次封存的兼容入口。当前 stable 首项不能掩盖后续旧 rc 版本。

两种操作在每个文件读取前后检查 release metadata 与 asset ID；只允许读取自身引起的下载次数变化，其余变更均失败。公开发现入口在结束时再次验证。安全 JSON 收据只含源码、release ID、文件名、大小、digest 和 asset ID；不记录凭据、签名 URL 或私有路径。工作流把成功报告或最小失败记录保存为 Actions artifact；读回成功不会发布，TOS 检查及正式发布仍由运营者负责。

<a id="verification"></a>

## 验证

只安装 owner 包：`npm ci --prefix scripts/owner/muse-release-artifact-transfer --ignore-scripts --no-audit --no-fund`，再运行 `node --test scripts/owner/muse-release-artifact-transfer/*.test.mjs`。Owner 测试使用临时目录、注入的 GitHub adapter 和模拟字节流，不申请网络监听器或调用 GitHub 服务。夹具覆盖原字节与报告绑定、匹配跳过、完整转运、源码与可见性变更、跳转、凭据不外传、流长度、digest 与公开发现入口。

Actions 入口拒绝本地执行、其他仓库、非人工事件与其他分支。可运行 `node scripts/owner/muse-release-artifact-transfer/run.mjs --help` 查看帮助；真实 runner 执行须先提供确认清单。读回收据只放在 runner 临时目录，并排他创建以保留已有记录。

<a id="dev-note"></a>

## 开发说明

无。
