---
description: "guard 家族的包映射：建议性重复工具提醒、单次工具调用超时策略、报告被热加载撤走工具的组装守卫，以及拒绝破坏短剧格式规则的写入或付费提交的短剧门禁，供选择或组合 guard 的用户与维护者阅读。"
kind: "package-group"
---

# guard/：循环卫生与组装守卫家族

[English](README.md) | 中文

## 概述

`guard/` 组让一个会话对自己真正在做什么保持诚实。`repeat-tool-reminder` 会在模型重复完全相同的工具调用时请它改变方法或结束任务，让卡住的循环不再浪费时间和 token。`timeout-policy` 为声明了限时的工具调用设置时间上限，让挂起的调用返回清晰的超时错误。`composition-guard` 盯的是组装本身：当一次热加载从一个正在运行的会话里撤走工具时，它在日志与该对话里把它说出来，并写明恢复方式。`drama-gate` 是短剧组装挂载的领域守卫：它会拒绝把旁白写进发声轨道的写入、越过镜头时长或字数预算的写入，以及在正式资产门禁通过之前提交的付费生成，且每次拒绝都写明具体修法。原先两个守卫都在 `dsh` 基础组合包中随附。

## 目录

- [包](#packages)
- [相关文档](#related-documentation)
- [开发备注](#dev-note)

-----

<a id="packages"></a>
## 包

四个小插件分别覆盖四种模式；下文每个 README 都说明何时保留、调优或移除它。

| 包 | 提供什么 |
|---|---|
| [`repeat-tool-reminder/`](repeat-tool-reminder/README.zh.md) | 在模型重复完全相同的工具调用时提醒它，使其改变方法或结束任务 |
| [`timeout-policy/`](timeout-policy/README.zh.md) | 为声明了限时的工具调用设置超时，让模型得到清晰错误而不是无限等待 |
| [`composition-guard/`](composition-guard/README.zh.md) | 报告工具被一次热加载组装撤走的会话，让人知道该重启宿主 |
| [`drama-gate/`](drama-gate/README.zh.md) | 拒绝破坏短剧格式规则的写入或付费提交，并写明修法 |

-----

<a id="related-documentation"></a>
## 相关文档

先从工具子系统参考了解三个 guard 都依赖的工具调用流水线与作用域视图，再看重复提醒的配置、超时库决策，以及组装守卫所报告的这次重载缺陷。

- [工具子系统参考](../../docs/subsystems/tools.zh.md)——各 guard 所依赖的工具调用流水线与作用域视图。
- [生成配置目录](../../docs/config-catalog.zh.md#deepseek-aidsh-repeat-tool-reminder)——重复调用提醒的每个受支持字段。
- [超时截止时间库 Agent Note](../../.agents/notes/implemented/architecture/2026-07-06-timeout-deadline-library.zh.md)——`timeout-policy` 所执行的时序／终止拆分。
- [热加载移植陷阱 Agent Note](../../.agents/notes/implemented/architecture/2026-09-17-product-capability-plane-and-port-traps.zh.md)——`composition-guard` 所检测的缺陷，以及为什么只有重启才能恢复。

<a id="dev-note"></a>
## 开发备注

<details>
<summary>维护者的工作上下文——点击展开</summary>

无。

</details>
