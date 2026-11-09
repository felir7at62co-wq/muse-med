---
description: "无需密钥的 PTC 验证，覆盖已执行、空白和新建会话中的精确 Skill 发布版本选择。"
kind: "reference"
---

# 通过 PTC 选择 Skill 发布版本

[English](README.md) | 中文

已发布的 Headless PTC 配置通过实际 tools.skill 和 tools.market_version 分派运行 [Native 生命周期](../muse-skill-market-version-binding/README.zh.md)。每个程序输出完整的实际类型化结果。主会话在默认值更改为版本二的前后均加载版本一。之前的空白会话和新建会话在首次任务中分别加载版本二。

三个真实 Agent 都将完整的 Skill 结果呈现在随后的模型请求中。必读绑定事件、投影、归档标识和所选资源字节独立于程序文字进行检查。主 Agent 还接收每个完整的生命周期结果，其中包含默认值更改和子 Agent 的绑定观察。工作区凭据记录与 Native 场景相同的精确版本选择。
