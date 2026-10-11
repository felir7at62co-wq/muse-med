---
kind: upgrade-guide
description: V2 剧本批准结果在工具内容中显示精简的审校回执。
---

# 剧本审校结果

[English](guide.md) | 中文

## 变更

`screenplay_project` 的 V2 `review approve` 在工具内容中投影为 `story-faithful-review-result-v2` 回执，不再显示完整候选及渲染剧本。回执绑定候选、审校、验收及修订号，使大外层 PTC 结果被截断后仍可校验日志。PTC 程序仍取得完整的 `{revision, candidate, rendered}` 规范值。其他审校保留原有内容。旧的完整候选审校日志仍受支持；现有会话文件无需迁移。

## 迁移

1. 解析原生工具内容的调用方应读取 `review_receipt` 及其绑定编号，或调用 `read_candidate` 取得完整版本。使用 PTC 结构化返回值的程序无需修改。
2. C 审校程序成功结束后，在后续模型轮提交。只有回执不能证明外层执行成功。
3. 确认候选编号与回执一致，且后续 `commit` 与 `export` 成功。外层失败、结果缺失或回执不匹配仍会被拒绝。
