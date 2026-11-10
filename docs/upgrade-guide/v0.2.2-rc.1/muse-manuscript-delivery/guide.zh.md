---
kind: upgrade-guide
description: "Muse 剧本交付要求当前版本的范围审校或明确草稿，视频工作还须绑定来源证据，自定义配置需要 sessionProjections。"
---

# 交付前登记最终剧本版本

[English](guide.md) | 中文

## 变更

此前，已有剧本文件可以直接交付，无需指明最终字节是否经过审校。Muse 编写与改稿任务现在要求 `manuscript_revision` 交付登记。`reviewed` 登记使用实际最终文件的一致性审校，并标明核对范围；`draft` 登记说明未完成的检查或已知问题，无需额外真人批准。`present` 原样使用返回标签。修改文件会使登记失效，Markdown 审校不能证明导出的 Word 已通过。

视频工作进行 `reviewed` 交付还须有来源审校。成功加载 `video-to-screenplay` 或明确调用来源审校后，该要求会保留，省略 `source_mode` 不能绕过。来源与文字问题分别保留。来源标签只涵盖明确原片秒范围内的所选正文行、采样原帧与保存 ASR，不认证全片、原音、人物身份或媒体同源。

自动检查识别同时含常见场次标题和戏剧动作或对白的文稿，其他自定义格式可显式登记文件。普通报告、仅翻译和仅格式转换保持原交付方式。对照与导出仍可在审校前使用。明确文件请求没有核实交付回执时，可收到受限的已记录补交提醒；代码或链接不代表交付。仅要求聊天正文或讲解时不要求文件。已有文稿文件与 Session 格式代际保留。

公开 `manuscript-revisions` 插件现在依赖 `sessionProjections`，即使关闭交付检查也需要该服务。启用插件会等待投影注册完成。

## 迁移

1. Muse 内置配置已提供所需服务。加载 `@deepseek-ai/dsh-desktop-host/manuscript-revisions` 的自定义配置还须加载 `@deepseek-ai/dsh-session-projection`。独立审校另需 [Host README](../../../../apps/desktop-host/README.zh.md) 所述的 Agent 注册、预设与 spawn 提供方。
2. 保存实际最终文件。改稿时明确所选原稿 `current`、不同路径的最终 `candidate` 及范围；只审最终文件不能批准改稿交付。新创作不补造原稿。视频工作用 `action: source_fidelity` 和审校 `task`，通过 `video_sources` 指定已保存的 `review_id`、原片秒范围、`draft_lines` 和 `frame_ids`；再按受影响文字选择 `continuity`、`cross_episode` 或 `repetitions`。同版本、同范围可复用有效凭据，导出后的最终字节仍须绑定。
3. 传入 `action: delivery`、`candidate_paths`、`delivery_mode: reviewed`，视频工作同时传 `source_mode: video`。检查未知或问题未解决时使用 `delivery_mode: draft`，并以 `note` 说明缺口。将每个返回的 `files[].label` 原样用作对应 `present` 描述。
4. 确认实际 `present` 回执。文件或来源证据变化、标签扩大到未查范围时须拒绝；明确草稿仍可交付。普通交付保持 Office `manuscriptRevisions.continuityDeliveryChecks` 开启，`continuityMaxDeliveryCorrections` 限制完成提醒次数。
