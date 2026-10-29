---
kind: upgrade-guide
description: Read 消费方需要改为使用行和列续读游标，而不是旧的长行截断后缀。
---

# Read 续读

[English](guide.md) | 中文

## 变更

当一行超出配置的字符或字节上限时，`read` 现在返回续读游标。结构化结果新增 `continuation`；分页和版本异常时返回 `versionBefore` 及可选的 `versionAfter`，续读的首行还会返回 `column`。从开头一次完整读取且版本未变化时，返回字段和文字保持原状。部分行不再带旧的 `line truncated to … chars` 后缀。提供方版本是元数据，不是内容哈希或原子快照。

## 迁移

1. 更新 `read` 结果消费方，使用 `continuation.offset` 和 `continuation.column` 继续读取；`column` 是请求首行从 1 开始的 Unicode 码点位置。包含续读游标或从大于 1 的列开始的结果不能当作完整文件读取。
2. 跨页比较提供方的读前和读后版本；版本变化或不可用时，不能凭这些页确认同一稳定版本。处理已记录的 Session 时继续兼容旧截断后缀。
3. 验证超出 `readMaxLineLength` 的单行可通过连续页面拼回，且字节上限不足以容纳下一个码点时会报错，而不是返回不前进的游标。
