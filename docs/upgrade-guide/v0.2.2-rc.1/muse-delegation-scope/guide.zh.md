---
kind: upgrade-guide
description: "Muse 子代理调度限制从已移除的工具配置迁移到预设持有的创建策略。"
---

# Muse 子代理调度

[English](guide.md) | 中文

## 变更

更新后的 `@deepseek-ai/dsh-tool-subagent` 拒绝 `config.toolFilter`。Muse 预设现于委派工具旁挂载 `@deepseek-ai/dsh-desktop-host/delegation-policy`。它的串行 `agent/created` 监听器在排队任务开始前，于实际子代理自己的工具作用域中限制 `schedule_create`、`schedule_edit`、`schedule_list` 和 `schedule_view`。限制覆盖已有及后续注册、模型 schema、发现、原生执行和 PTC 子调用。根会话保留调度工具。策略也禁止后续以历史名称 `schedule_delete` 和 `schedule_update` 注册的工具。

这保留既有产品限制，不改变子代理身份提示的继承，也不会自动创建另一份预设。子代理由运行时父子归属判断；单独恢复为实时根代理的旧委派 Session 仍属于根代理。Session 记录不重写。

## 迁移

1. 同步升级 Desktop 应用与内置 Host。随包的 Standard、PTC、Cordis、短剧和历史恢复组合已声明新策略。
2. 如维护复制的 Muse 预设，从 spawn 与 fork 工具配置中移除 `toolFilter`，在委派组内添加同级行 `id: delegation-policy` 和 `name: '@deepseek-ai/dsh-desktop-host/delegation-policy'`。不要在缺少等效子作用域策略时直接删除旧过滤。
3. 独立预设的工具仍须明确配置。即使子代理自己的组合注册了这四项工具，新策略也会禁止调度；它不授予其他工具或文件系统权限。
4. 确认父会话能够列出调度，而实际委派子代理无法通过原生或 PTC 执行发现或调用这四项工具。检查子代理首个请求；策略激活失败须终止创建，不能放行无限制执行。
