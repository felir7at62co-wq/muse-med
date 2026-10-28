---
kind: upgrade-guide
description: "Muse 延后提供专业工具定义，新建 Bot 团队分别使用主控与专业执行预设。"
---

# Muse 工具发现与 Bot 职责

[English](guide.md) | 中文

## 变更

Muse Desktop 初始提供标准工具、Bot 协作工具，以及简短的获准能力组目录。发现指引建议在自行编写 shell 或网页替代方案前搜索专业能力，不要求必须搜索，也不阻止执行。专业工具通过 `tool_search` 发现，`tool_context` 管理临时加载与常驻工具。新团队的主 Bot 使用 `bot-coordinator`，Muse 专业执行者使用 `short-drama`。已有会话保留原预设、工作间和历史。工具选择不增加权限，也不删除历史工具数据。

## 迁移

1. 升级时保留原 home 与会话数据，无需迁移账号或工作间。
2. 自行维护 Desktop 配置时，在 Host 挂载一次 `@deepseek-ai/dsh-tool-discovery`，设置 `alwaysLoad` 与 `capabilities`；可选的 `maxDirectoryChars` 限制初始目录 JSON（默认 `2000`，范围 `256`–`16384`）。不要在各预设重复挂载服务。
3. 通过 `tool_search` 查找专业工具。通过 `tool_context` 的 `status`、`load`、`pin`、`release`、`unpin` 查看或调整工具。成功保存的 Bot 常驻设置用于后续会话分段，临时加载仅属于当前会话。
4. 新建团队即可使用新的主控职责，已有会话不会被静默改成其他预设。开始工作前确认初始能力目录、工具状态与 Bot 预设。加载或常驻工具不应重复或改写未变化的目录。

模型缓存与持久化行为见[工具发现参考](../../../../packages/core/tool-discovery/README.zh.md)。
