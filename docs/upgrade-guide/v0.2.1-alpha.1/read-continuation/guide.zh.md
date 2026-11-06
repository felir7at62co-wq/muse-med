---
kind: upgrade-guide
description: read 工具返回带版本的 Unicode 续读位置，不再丢弃长行的剩余文字。
---

# 带版本的读取续读

[English](guide.md) | 中文

## 变更

`read` 工具返回原样行片段，不再给长行追加截断后缀。其规范结果新增必填 `column` 和 `version`，尚有未读文字时还包含可选 `continuation: {offset, column}`。请求接受 `column` 和 `expected_version`。列号及 `readMaxLineLength` 按 Unicode 码点计数，不按 UTF-16 单元或字素簇计数。自定义结果校验器、工具客户端和输出解析器需要接受这些字段及新的续读 footer。

配置限额继续生效：默认 2,000 行、每个行片段 2,000 码点，片段及分隔换行共 51,200 UTF-8 字节。最后一行只返回部分内容时不报告 EOF。完整文件的模型侧文本保持不变。此前保存的读取元数据仍可读取，无须重写 Session 日志。

## 迁移

1. 按[文件系统工具 README](../../../../packages/fs/tool-fs/README.zh.md)更新自定义 `read` 请求和结果定义。保留 `lines[].number` 与 `lines[].text`；不要把返回的行片段当作完整物理行。
2. 使用原样返回的 `continuation.offset`、`continuation.column`，并将上一页的 `version` 作为 `expected_version` 续读；仅在没有 continuation 时结束。遇到 `FS_STALE_VERSION` 时从当前文件第 1 行、第 1 列重新开始，不混用不同版本的页面。
3. 删除对 `... (line truncated to ... chars)` 及旧分页 footer 文案的判断，保留部署限额。字节预算无法容纳下一个 Unicode 码点时返回 `FS_TOO_LARGE`，不返回无法前进的游标；配置的字节数须能容纳一个完整码点。
4. 确认连续读取能逐字恢复长行，包括第 2,000 列后的文字和跨流式块的 emoji，并确认文件变化后旧版本被拒绝。仅最后一页到达 EOF，不能证明之前的页面均已读取。
