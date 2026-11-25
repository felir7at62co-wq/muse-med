---
kind: upgrade-guide
description: 短剧插件将可复用的辅助接口移至包子路径，并移除内部工具工厂的导出。
---

# 短剧插件辅助接口的导入路径

[English](guide.md) | 中文

## 变更

原先从短剧设置、镜流连接或工作台连接包的根入口导入辅助接口的 Host 调用方，现在通过包子路径导入。镜流与剧本工坊工具包不再导出工具工厂及其私有常量。Cordis 配置仍使用包的根入口。

## 迁移

1. 从 `@deepseek-ai/dsh-drama-settings/draft-directory` 导入 `draftDirectory`。
2. 从 `@deepseek-ai/dsh-jingliu-connection/media` 导入 `boundedBytes`、`mediaPath` 和 `projectMediaFolder`。
3. 从 `@deepseek-ai/dsh-workbench-connection/transport` 导入 `WorkbenchSessions`、`boundedBytes`、`isRecord`、`requestJson` 和 `workbenchOrigin`。从 `@deepseek-ai/dsh-workbench-connection/scripts` 导入 `scriptDetail`、`scriptList`、`scriptOf` 和 `scriptSummary`。
4. 通过包根入口挂载镜流与剧本工坊工具，并调用注册后的工具。原有的 `workflowTools`、剧本工坊工具工厂和常量以及 `SCRIPT_WORKSHOP` 均属于内部实现，没有公开替代接口。
5. 重新构建调用方，运行一个挂载相关插件并调用所导入辅助接口的场景。
