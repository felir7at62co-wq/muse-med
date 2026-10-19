---
kind: upgrade-guide
description: Muse Desktop 会拒绝覆盖用户返稿修改的受保护文稿导出与交付。
---

# Muse 用户返稿保护

[English](guide.md) | 中文

## 变更

Muse Desktop 的 Office 组合全局注册 `manuscript_revision`。完成上一稿与用户返稿的对比后，Word 导出以及通过 `present` 或 `dsh_im_return_file` 交付，会拒绝改动用户受保护段落或恢复被删除原文的候选。直接调用 `write`、`edit` 不能覆盖当前返稿原件。此前文稿可能未经此项对比就交付。

同一会话此前交付的 Markdown、UTF-8 文本和 Word 文件在同一路径变化时，会在该会话下一次真人输入时检测。外部变化的修改者未经确认，按返稿保守保留。改名或重新上传的文稿需要明确关联对比路径。每个会话只有一份活跃文稿对比。IM 文件返回的基线记录代表发送队列受理，不代表接收人已经成功收到。保护检查规范化后的段落文字、顺序及删除记录，不判断故事语义。已注册校验路径之外的 shell 写入和直接文件链接不受操作系统级锁定。系统提示词和已有会话日志不变。

## 迁移

1. 保留上一稿与实际返稿。二者尚未关联时，调用 `manuscript_revision`，提供 `action: "compare"`、`baseline_path` 与 `revised_path`。没有上一稿，应说明无法识别历史修改，不能把模型新输出伪装成基线。
2. 阅读返回的修改，精修未改部分并另存新候选，保留用户新增、改写的段落，不恢复删除内容。独立文稿使用新会话。
3. 确需调整受保护段落时，取得真人消息：`允许修改用户改稿：` 后紧接该处完整文字，或 `允许恢复用户删除：` 后紧接被删除的完整原文。用 `action: "authorize"`、对应 `change_id` 与准确的 `authorization_quote` 仅登记这一处授权；普通润色请求不构成授权。
4. 用 `action: "review"` 与完整 `candidate_paths` 检查候选。确认 `state: "passed"` 后，导出并交付这些实际文件。后续校验拒绝时，修正候选或取得该处明确授权，不能清空对比。通过仅代表段落保留检查。

资源上限通过 Office 的 `manuscriptRevisions` 显式配置，参见 [Host 参考](../../../../apps/desktop-host/README.zh.md)。已有文件无需自动转换，没有基线不表示用户没有修改。
