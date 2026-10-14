---
kind: upgrade-guide
description: 覆盖验收记录使用逐集 v2 摘要，显式短剧分工需要支持 work_scope 的读取程序。
---

# 短剧分集工作范围

[English](guide.md) | 中文

## 变更

新覆盖记录使用 `version: 2` 和 `episode_manifest_sha256`；旧技能副本无法验证这些记录。新版读取程序仅在原整份清单摘要仍匹配时保留 v1 记录有效。未声明 `work_scope` 的既有清单继续采用整剧分集完整性和前序集验收规则。

显式 `work_scope.episode_ids` 定义本地分工集号，与表示整剧总集数的 `expected_episode_count` 分离。分工状态完成仅表示该工作范围完成，不代表整剧完成。分工拆分保留其他协作者的文件和清单条目；无效既有清单在写入前即报错。交付文件名保留 `01` 至 `9999` 的完整规范集号；零和越界集号会被拒绝。

草稿投影要求有效的时间线和来源清单成对存在。`completion_basis=editing_inputs` 与 `editable_draft_verified=false` 表示编辑输入已准备，不能证明外部编辑器的实际可编辑草稿已经通过验证。

## 迁移

1. 同步更新相邻的 `tweet-drama-core`、`tweet-drama-script-split`、`tweet-drama-pipeline` 和 `tweet-drama-delivery` 技能目录。个人安装副本不会自动同步。
2. 备份 `episodes/manifest.json`。确认授权集号列表，再按[范围 schema](../../../../packages/drama/skills/skills/tweet-drama-core/references/io-contract.md#episode-work-scope-and-coverage) 添加 `work_scope.episode_ids`。保留真实整剧总集数，不从现有文件推断工作范围。
3. 运行 `episode_coverage.py <project> audit`。处理缺失原文、过期摘要和不确定的映射。只对实际核对且通过的集运行 `accept <episode...>`；不能批量批准 pending 条目。新验收的集获得 v2 记录。
4. 授权提交前运行 `gate <episode...>`，并运行 `pipeline_state.py <project> sync`。核对 `completion_scope=work_scope` 和准确的 `scope_episodes`。gate 返回非零时停止提交。这些命令不会生成或提交付费媒体。
