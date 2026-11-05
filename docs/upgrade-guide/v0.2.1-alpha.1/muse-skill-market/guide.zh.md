---
kind: upgrade-guide
description: "Muse 市场的发现与发布仅接受 Skill，并移除 Bot 制作和启动操作。"
---

# Muse Skill 市场

[English](guide.md) | 中文

## 变更

Muse 网页和桌面市场分发 Skill。市场移除 Bot 的发现、制作、上传、下载和启动操作，直接调用市场接口也会拒绝 Bot 发布包。已有安装记录保持可读，以便旧会话恢复已绑定的资源。

Skill 卡片与制作预览根据技能名称和用途自动匹配 Muse 角色。制作或上传的发布包保存选中的形象标识，使预览与公开卡片一致。

## 迁移

1. 同步更新市场 Host、云端服务和网页。使用匹配的生成 Remote 客户端，因为 `sources()` 返回本地 Skill，`prepare(metadata, skillNames)` 制作 Skill 发布包。
2. 作者打开**制作 Skill**，选择本地 Skill 或上传 Skill ZIP，检查自动匹配的角色预览，再提交草稿审核。发布包必须声明 `kind: "skill"` 并包含所引用的说明文件和资源。
3. 确认发现页和创作者列表只显示 Skill，上传 Bot ZIP 会被拒绝，同一 Skill 在预览、审核与公开发现页显示相同角色。打开已有会话，确认已绑定资源仍能加载。
