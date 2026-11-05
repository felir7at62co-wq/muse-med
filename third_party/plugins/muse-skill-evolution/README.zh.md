---
title: Muse Skill Evolution
description: 独立任务学习、自有 Skill 版本和复盘控制。
kind: reference
---

# Muse Skill Evolution

[English](README.md) | 中文

Muse 从新完成的工具任务中学习可复用流程。本独立插件沿用 DS Bot 的经验复盘标准，不加载已归档的 Bot 运行时。它生成普通 Markdown Skill，通过原生技能发现服务提供，并保留可查看和回退的提案及版本。

## 学习与所有权

用户发起的主会话回合完成，且工具调用达到 `minToolCalls`、至少一个结果成功时，会保存有长度限制的证据批次。纯聊天、委派复盘、失败和取消的回合不参与。主 Agent 空闲且达到配置的等待时间后才开始复盘。不扫描已有会话历史；中断的复盘不会自动重复请求模型。

复盘通过独立持久化原生会话，使用来源回合选择的服务商、模型及思考强度，不提供任何工具。请求、响应、用量和来源会话身份均可查。结果可以是新建、更新或无需改动。回合完成不代表用户验收；复盘要求可复用证据，并排除密钥、个人事实、复制日志及一次性进度。

自动应用仅限新建的 `muse-learned-*` 技能，以及插件已拥有且文件未改动的技能。更新必须匹配复盘时的精确基线。现有手动、内置和工作区技能只生成提案。手动修改、重名、只读权限或超出来源会话可写目录时，保留提案且不覆盖文件。不写生成脚本、全局指令或记忆文件。自动应用还要求真实来源会话仍然存在。

## 管理与文件

可以让 Muse 使用 `muse_skill_evolution` 查看已学习技能、提案和版本历史。写入操作使用实际调用会话的权限；应用提案不能接管无关技能。回退从已保存版本写入一个新版本，并检查当前文件哈希，旧版本仍保留。

默认私有状态目录为 `<DSH_HOME>/muse-skill-evolution`，生成文件位于 `<DSH_HOME>/skills/<name>/SKILL.md`。两个位置均可配置为绝对路径。带版本号的索引、不可变版本文件和恢复日志维护文件与索引事务。损坏或未来版本状态会明确报错。记录达到容量限制后拒绝新增并保留已有历史。恢复仅确认已经写入的技能文件；尚未写入文件的中断事务保留为阻塞回执，等待重新授权的应用。提案和复盘回执留在本地；插件不提交产品反馈或发布技能。

## 配置与模型用量

包内补丁在 Host 中激活插件。`enabled` 和 `autoApplyOwned` 默认均为 `true`。设 `enabled:false` 可停止收集新复盘和写入技能；设 `autoApplyOwned:false` 则保留提案供显式应用。`home`、`skillsRoot` 可覆盖私有目录。

默认值为 `idleMs:600000`、`minToolCalls:3`、按 UTC 日期计算的 `maxReviewsPerDay:4`、`inputMaxChars:24000`、`outputMaxTokens:4096`、`requestTimeoutMs:120000`、`maxSkills:20`、`descriptionMaxChars:300`、`contentMaxChars:8000`、`toolOutputMaxChars:24000`。激活时校验配置。模型复盘计入所选服务商正常用量，可能产生相应费用。设 `maxReviewsPerDay:0` 可停止复盘请求并保留已收集任务。后续合格活动触发调度时会继续已有队列，不设每日轮询任务。

## Model Experience

管理工具通过正常记录的执行路径返回本地状态、提案和版本回执。复盘模型接收有长度限制且已脱敏的任务文本、工具结果摘要和可用技能目录。模型可见的输入输出记录在独立会话中。提交后的技能通过原生提供方参与发现，下一个任务可以用 `skill` 加载完整内容。

模型仍可能提出不合适的流程。版本和所有权检查保护文件，不能证明经验内容的语义质量。无密钥场景验证执行、日志、权限、发现及回退，不证明真实服务商的创作质量。

## 开发

在已构建且 Host 依赖匹配的仓库中，运行 `pnpm --dir third_party/plugins/muse-skill-evolution test` 执行针对性检查，运行 `pnpm --dir third_party/plugins/muse-skill-evolution run package -- --out /absolute/output` 生成归档。打包使用私有临时目录，包含源码哈希、精确 Host 身份、Apache 署名和保留的 Bot 修订号，不读取真实 Muse 用户目录。
