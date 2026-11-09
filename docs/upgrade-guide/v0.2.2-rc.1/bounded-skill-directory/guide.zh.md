---
kind: upgrade-guide
description: Skill 目录消费者必须区分所选摘要与完整的允许调用目录。
---

# 已选择的 Skill 目录

[English](guide.md) | 中文

## 变更

Desktop creation 最多展示十二个允许模型调用的 `muse-market` 摘要，其他来源保持不变。主动缩短的 `skill-catalog` 消息带有可选的 `bounded: true`；`incomplete: true` 仍表示发现失败。未出现在所选摘要中的名称仍可能被允许并可查询。

所属加载器按条件提供仅查询元数据的 `skill_catalog`，支持完整查询与分页。它不授予正文加载或用户调用权限。未裁剪目录保留既有文本与本步可用工具集合。自定义 profile 默认不限制来源。

## 迁移

1. 读取目录 `entries` 的消费者须检查 `bounded`。展示所选摘要时，不要把省略名称视为不可用。单独保留 `incomplete`；发现失败不等于主动选择。参见[工具包](../../../../packages/skill/tool-skill/README.zh.md)。
2. 自定义 profile 可在 `tool-skill` 行配置 `catalogSourceLimits` 与 `catalogPageSize`。受限来源需要同一作用域加载器的 `skill_catalog` 在本步可用，并保留原调用限制。代码中查询本步工具可用性时，先用 `tools.resolve(context)` 解析，再把结果集合交给 `tools.schemas(agent, set)`，完成后释放该集合。
3. 在同一 Session 和查询中原样传回 `nextCursor`。跨会话、过期或无效游标会被拒绝；应重新查询元数据，不要改写标识或偏移量。完整 Skill 正文仍通过精确名称与普通 `skill` 权限加载。
4. 确认超出配置上限的来源产生 `bounded: true`、提供元数据查询工具，且能发现并加载被省略的允许 Skill。低于上限的目录须保留完整摘要与先前本步可用工具。Session 事件封装及既有存储代保持不变；[类型确认记录](../../../persistence-changes/2026-11-09-bounded-skill-catalog.zh.md)记录新增可选来源字段。
