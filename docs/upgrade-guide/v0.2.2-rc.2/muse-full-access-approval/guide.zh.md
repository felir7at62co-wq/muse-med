---
kind: upgrade-guide
description: Muse 桌面版的完全权限预设会为需要审批的操作显示确认卡。
---

# 恢复 Muse 桌面版的镜流审批

[English](guide.md) | 中文

## 变更

Muse 桌面版的完全权限预设（`danger-full-access`）原先使用审批策略 `never`，会自动拒绝需要确认的镜流写入操作。该预设现默认使用审批策略 `ask`，仍允许写入工作区之外的位置。已有会话保留日志中的权限，用户配置中显式设置的值优先于新默认值。

## 迁移

1. 如果用户配置的 `cordis.patch.yml` 显式把 `permission.config.presets.danger-full-access.approval` 设为 `never`，改为 `ask`，然后重启 Muse，即可在完全权限下启用审批。
2. 在使用完全权限且审批策略为 `never` 的已有会话中，从权限选择器选择**完全权限**，或输入 `/permission danger-full-access`。
3. 发起一项你打算执行的镜流写入，确认 Muse 在提交操作前显示审批卡。
