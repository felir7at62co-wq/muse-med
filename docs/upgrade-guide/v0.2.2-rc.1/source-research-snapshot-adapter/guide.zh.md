---
kind: upgrade-guide
description: "Muse 选材研究的新快照使用适配器版本 1.0.1，旧版插件读取器会拒绝此版本。"
---
# Muse 选材研究快照适配器 1.0.1

[English](guide.md) | 中文

## 变更

`muse-source-research` 的新快照保留 `schemaVersion:1`，使用 `adapterVersion:1.0.1` 保存红果观察记录中的缺失指标原因。旧版插件读取器仅接受 `adapterVersion:1.0.0`，会拒绝这些新快照。更新后的读取器使用各自的规范化规则校验两个版本。现有快照的字节、ID 和历史原因保持不变。报告和映射继续使用 `adapterVersion:1.0.0`。

## 迁移

1. 在共享项目中采集新证据前，更新所有读取该项目的 `muse-source-research` 安装。不要更改 `.muse/source-research/snapshots/v1/` 中文件的版本标记或重写文件。
2. 如需修正后的缺失指标原因，使用 `source_snapshot` 和 `action:collect` 采集新的红果快照。用 `action:read` 和返回的 `snapshotId` 读取，确认 `adapterVersion:1.0.1` 及原观察记录的原因。现有快照仍可读取，保留原哈希和原因。
