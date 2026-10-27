---
kind: upgrade-guide
description: Muse以每秒五个有效字估算未声明时长的发声镜头，并计入已声明动作复杂度。
---

# Muse发声时长估算

[English](guide.md) | 中文

## 变更

Muse短剧与创作预设把 `tool-shot-script.config.speechCharsPerSecond` 设为5，插件默认值仍为8。`drama_shot` 与 `muse_production` 共用此语速。发声镜头至少保留已声明动作复杂度的估算时间；strict检查不接受未知复杂度。明确的正整数秒时长仍优先，已保存方案和任务卡不会自动改写。

## 迁移

1. 准备生成前重新预览受影响的未完成集，不从旧估算推断新的包时长。
2. 部署需要其他估算时，在编译器配置把 `speechCharsPerSecond` 设为至少1的数值。保留已明确审核的镜头时长，另外核对先后动作与反应时间。
3. 确认返回的镜头和分包时长符合当前模型；执行技能中的发声原文预检，再审核实际画面和声音。估算时长不代表表演或交付验收通过。
4. 覆盖审核和发声预检共用对原文已列人物的普通表演说明的解析；身份或发声含糊仍待核对。直接映射现有`shots/EP13-9x16.md`。范围内单集在核对映射后运行`accept 13 --episode-only`，再运行`gate 13 --episode-only`；保留项目范围和本集检查，不要求前序覆盖记录。按[迁移规则](../../../../packages/drama/skills/skills/tweet-drama-core/references/io-contract.md#existing-project-migration)处理；默认整剧检查保持不变，缺少覆盖证据不要求重做历史视频。
