---
kind: upgrade-guide
description: "Todo 工具的成功结果从数量句改为 JSON 进度结果。"
---

# Todo 进度结果

[English](guide.md) | 中文

## 变更

`todo_write` 成功时模型可见的结果改为含 `todos`、`counts`、`current`、`next` 和 `reminder` 的 JSON 文本，替代固定数量句。解析旧句子的消费者需要更新。新增的 `todo_update` 在修改一个任务后返回相同字段。`todo/write` 事件和任务字段保持不变。

## 迁移

1. 将成功的 Todo 结果文本作为 JSON 解析，不再匹配旧句子。`counts` 是数量，`current` 是进行中任务文字，`next` 是首个待处理任务或 null，`reminder` 是提示文本。
2. 持久任务状态仍读取 `todo/write` 中的完整清单。展示 `todo_update` 时使用成功结果中的 `todos`，因为调用参数只标识一个任务。
3. 确认完成一项并指定 `start_next: true` 后，其他任务仍保留，且最多启动一个待处理项。已有会话无需数据迁移。
