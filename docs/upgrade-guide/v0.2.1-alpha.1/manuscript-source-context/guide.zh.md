---
kind: upgrade-guide
description: 文稿调用方须解析相对输出路径，并支持带版本的审查分页及有来源依据的笔记。
---

# 文稿来源标签与审查分页

[English](guide.md) | 中文

## 变更

`manuscript_work` 返回带版本的 `audit` 目录和保存回执。`manuscriptReportMaxResultCharacters` 默认为 8000 个 UTF-16 单元，最小 1024，包含元数据。超大记录通过 `report_item_paged` 返回递归目录；标量字段完整保留，无法容纳时失败。小报告不变，某组读完不表示已读完整。

工作目录内已声明的输出路径使用 `./relative` 和 `/` 分隔符，不再返回原生绝对路径。外部路径和业务正文不变；持久记录保留原生绝对路径，绝对路径输入仍可使用。

`read_source.lines[]` 增加 `source_refs`/`source_line`，不改变 `text`。引文的 `line_labels` 保留发话和声音原写法，不判定可闻性。阅读页保留紧凑邻段，`citation_labels` 不带邻段；`bridge_ranges` 给出来源路径、哈希和范围。

范围声明须符合每条引用，故事时间须在 `time_basis` 给出引文或标题依据。`contextual_name` 要求称谓出现在所引发话正文，且字面发话标签唯一匹配已登记身份。无据笔记进入 `relationships_needing_recheck`，不参与恢复。发话归属不证明称谓所指、受话人或谁听见。

`explained_change` 须有解释证据和 `explanation_kind: explicit_change`，不满足条件的旧笔记进入 `comparisons_needing_recheck`。计划、条件奖励、相容算式和被阻止的危险不证明事件已完成。原文明示生效的任命或薪资标准就是变化，缺少付款证据只涉及实际领取，不能据此否定标准；最终摘要沿用原称谓。真实绑定任务要求从已有日志恢复，摘要和分叉前缀不能提供新用户请求。

`source_cues` 列出完整 △ 行及其行号、引用标签、路径和哈希，只作导航，不是时间或事件判定，也不是阅读回执；得出结论前须回读整场。

报告超出预算时，关系或对照回执优先提供完整 `record_review` 和 `record_review_notice`；合并结果仍放不下时，用 `record_review_omitted: true` 转向 `audit`，不截断正文。修正须同 ID 再次保存，持久结构不变。

## 迁移

1. 相对输出路径以 Session cwd 解析。沿每个 `report_sections[].request` 和 `continuation` 递归读到 `null`，以摘要和完整子集合还原记录。携带 `report_sha256`、返回的 `report_section` 和从 1 计数的 `report_offset`。文件、笔记、进度或配置变化后游标失效。`report_pending` 时须沿 `next_request` 读取，含有 `record_review` 的回执也一样。
2. 原句只引用 `lines[].text`，允许 `line_labels` 字段为空，使用来源场号或 `source_scene_id`。`speech_column` 从完整原行第 1 个 Unicode 码点计数。用 `source_cues` 定位后仍须回读对应场景。
3. 用原 ID 和当前证据修正标记笔记，登记发话人完整姓名或明确别名。发话人仍有歧义时省略 `contextual_name`，保留不确定的普通关系。
4. 来源页共用 `sourceReadMaxResultCharacters`（8000 个 UTF-16 单元，最小 1024），最小页无法容纳时失败且不计覆盖。数值结论前回读两端和 `bridge_ranges`，规则使用 `possible_change`，条件不足时保留未解决。
5. 保留问题 ID 和修正。要求超出 `manuscriptTaskRequestChars`（16000 个 UTF-16 单元，最小 1024）时，使用 `task_request`、`request_sha256`、`offset` 和 `column`，共用来源页预算。真人修改或重新绑定后游标失效；保留日志，不为恢复要求而重新绑定。字段与限制见[README](../../../../apps/desktop-host/README.zh.md)。
