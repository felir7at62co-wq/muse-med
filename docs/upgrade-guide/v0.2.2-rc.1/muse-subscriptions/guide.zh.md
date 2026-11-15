---
kind: upgrade-guide
description: "Muse 将默认 Codex 订阅 bundle 替换为 dsh-plugin-subscriptions，并保留旧私有数据。"
---

# Muse 订阅供应商替换

[English](guide.md) | 中文

## 变更

Muse Desktop 选择 `dsh-plugin-subscriptions`，替代默认的 `dsh-codex-subscription` bundle。现有订阅设置、供应商标识和增强附件接口不能直接互换。旧源码固定版本仍可用于归档恢复，默认构建不再选择它。

会话日志、附件源文件和旧凭据仍保存在磁盘上。旧增强预览、画板、PSD、标注状态与增强偏好不能直接导入。归档恢复构建保留旧 Codex native-CLI 子代理路径；替换插件使用普通 DSH 子代理。保留旧数据不会启用归档界面，也不能证明订阅访问可用。

## 迁移

1. 完成正在执行的工作，备份实际 Harness 主目录、Electron userData，以及 profile 的 `package.json` 和 `cordis.patch.yml`。包含原订阅凭据与附件数据；原始备份保持私有且不改动。
2. 使用更新后的 Muse Desktop profile，它选择 `dsh-plugin-subscriptions` 的 bundle 项 `llm-subscriptions`。托管升级备份 profile，并以字面量 `disabled: true` 停用占位行保留旧偏好行与配置。自定义组合需替换正在使用的旧项，避免同时启用两个 bundle。保留原文件供恢复。
3. 首次启用时，本地迁移器检查令牌字段、账号身份及令牌中声明的 OAuth client 后，仅将旧插件当前激活的 Codex OAuth 账号复制至 `$DSH_HOME/plugins/subscriptions/auth.json`。两个保留的供应商使用相同 OAuth client，但尚未验证真实登录或刷新。已有的新 Codex 数据不会被覆盖；旧凭据保持不变。其他旧账号需在新设置页重新登录。完成状态记录于 `$DSH_HOME/plugins/subscriptions/muse-codex-migration-v1.json`，退出后不会自动重新导入。导入失败会持久记录 `manual-login-required`，设置页仍可供用户主动登录。标记无法保存时，状态会明确提示重启后可能重试自动导入。不要通过删除标记或整体复制凭据文件重新连接。无密钥检查不能证明真实登录或推理成功。
4. 将旧增强预览、PSD 与标注文件随归档应用保留。需要时可将已存在的导出图片作为普通附件添加；这不会迁移可编辑画板或标注状态。不要通过删除旧会话文件隐藏不可用的展示功能。
5. 打开历史会话，核对文本和源附件。检查所选供应商与模型，必要时重新连接或选择，再分别验证选图、粘贴、真实跨窗口拖拽和一次真实模型请求。完成这些检查前，保留原归档和凭据。
