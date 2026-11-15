---
kind: upgrade-guide
description: "保留的 Muse Desktop 包必须分别验证 Muse 与 DSH Core 版本后才能发布。"
---

# 保留的 Muse 包身份

[English](guide.md) | 中文

## 变更

Muse 拥有独立产品版本。保留的 Desktop manifest 现使用 `schemaVersion: 2`：`source.productVersion` 来自 `apps/desktop/muse-product.json`，`source.dshVersion` 来自同一来源树的根 `package.json`。Desktop 包的 Core 版本必须与根版本一致。完成打包记录继续分别保留 `version` 与 `dshVersion` 字段。

上传器验证这两个原始版本，包括当前工作树已经更新的情况。它拒绝 v1 保留 manifest，以及缺少精确 Core 版本的 v2 记录，不会根据当前工作树推断旧包的 Core 版本。已有 attempt、安装包、Session 日志和私有 profile 均不重写。

## 迁移

1. 保留配置的 `DSH_DESKTOP_RELEASES_DIR` 下原始 attempt 目录及其 `manifest.json`、产物、校验和与完成记录。不要修改 attempt 来跳过验证，也不要替换其中的文件。
2. 优先从目标的已验证来源修订重新构建。CI 保留流程读取 `apps/desktop/muse-product.json`、根 `package.json` 和 `apps/desktop/package.json`，然后写入新的不可变 v2 attempt。Muse 产品版本与 Core 版本相互独立；两个 Core 包 manifest 的版本必须一致。
3. 如需重建旧 attempt，先恢复其已验证来源归档或提交，以及独立核对过的打包完成记录。从归档的 `muse-product.json` 确认 Muse 版本，从根与 Desktop 包 manifest 确认 Core 版本，并核对完成记录的 `dshVersion`、产物哈希与来源修订一致。在独立的恢复用 `DSH_DESKTOP_RELEASES_DIR` 中保留重建的 v2 清单，保持原始 run ID、attempt、已验证来源值与产物文件。完整保留原始 v1 releases 根目录，不要编造打包 run，也不要覆盖其 attempt。任何证据缺失或不一致时均应重新构建，不要猜测 Core 版本。
4. 指定路由的新 attempt 并使用现有机器配置，运行 `pnpm exec tsx apps/desktop/scripts/publish-desktop-ci.ts --check`，验证保留文件并预览发布。批准上传前，确认 `source.productVersion`、`source.dshVersion`、完成记录与产物校验和一致。验证或预览成功不代表已经发布。
