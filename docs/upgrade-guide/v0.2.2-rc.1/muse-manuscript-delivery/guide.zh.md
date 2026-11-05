---
kind: upgrade-guide
description: "Muse 剧本交付要求当前版本的范围审校或明确草稿登记，自定义文稿配置需要 sessionProjections。"
---

# 交付前登记最终剧本版本

[English](guide.md) | 中文

## 变更

此前，已有剧本文件可以直接交付，无需指明最终字节是否经过审校。Muse 编写与改稿任务现在要求 `manuscript_revision` 交付登记。`reviewed` 登记使用实际最终文件的一致性审校，并标明核对范围；`draft` 登记说明未完成的检查或已知问题，无需额外真人批准。`present` 原样使用返回标签。修改文件会使登记失效，Markdown 审校不能证明导出的 Word 已通过。

自动检查识别同时含常见场次标题和戏剧动作或对白的文稿，其他自定义格式可显式登记文件。普通报告、仅翻译与仅格式转换保持原交付方式。`manuscript_revision` 对照与导出仍可在审校前使用。明确要求剧本文件却没有核实交付回执时，即使回复包含代码或下载链接，也可按配置收到受限的已记录补交提醒。仅要求聊天正文或讲解的请求不要求文件。已有文稿文件与 Session 格式代际保留。

公开 `manuscript-revisions` 插件现在依赖 `sessionProjections`，即使关闭交付检查也需要该服务。启用插件会等待投影注册完成。

## 迁移

1. Muse 内置配置已提供所需服务。加载 `@deepseek-ai/dsh-desktop-host/manuscript-revisions` 的自定义配置还须加载 `@deepseek-ai/dsh-session-projection`。独立一致性审校另需 [Host README](../../../../apps/desktop-host/README.zh.md) 所述的 Agent 注册、预设与 spawn 提供方。
2. 修改剧本后保存最终交付文件，以 `action: continuity` 调用 `manuscript_revision`，将所选原稿设为 `current`，不同路径的最终文件设为 `candidate`，并明确范围。只审最终文件不能进行改稿任务的 `reviewed` 交付；已有登记在 `present` 时也须满足相同检查。全新创作可使用无原稿的内部审校。随后传入 `action: delivery`、`candidate_paths` 和 `delivery_mode: reviewed`；也可以使用 `delivery_mode: draft`，并以 `note` 说明尚未完成的检查。将返回的每个 `files[].label` 原样用作对应 `present` 描述。
3. 验证文件变化及扩大到未查范围的标签会被拒绝，而明确草稿可以交付。只有有意停用此交付策略时才调整 Office 的 `manuscriptRevisions.continuityDeliveryChecks`；`continuityMaxDeliveryCorrections` 限制完成提醒次数。
