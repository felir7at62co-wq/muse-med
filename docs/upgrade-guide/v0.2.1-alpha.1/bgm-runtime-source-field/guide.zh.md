---
kind: upgrade-guide
description: 离线 BGM 准备工具在运行时清单中明确记录复制发行包的来源。
---

# BGM 运行时发行包来源

[English](guide.md) | 中文

## 变更

可选的 Windows 离线 BGM 准备工具在 `runtime-manifest.json` 的 `packageSource` 字段记录复制发行包的来源。可执行文件和资源的哈希格式保持一致。

## 迁移

清单读取方应使用 `packageSource`。已有清单仍可进行字节校验；需要新字段时，用相同的已验证输入重新生成清单。不得用假定值替换测量的哈希。
