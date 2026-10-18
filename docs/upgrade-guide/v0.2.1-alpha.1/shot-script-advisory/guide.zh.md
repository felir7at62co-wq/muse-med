---
kind: upgrade-guide
description: "Muse 短剧模式以会话视频上限进行 drama_shot 提示型检查，并将检查草稿与正式单集包分开保存。"
---

# Muse 镜头脚本检查模式

[English](guide.md) | 中文

## 变更

Muse 短剧模式以 `reviewMode: advisory` 提供 `drama_shot`。脚本格式、资产声明、时长冲突等内容问题作为警告返回。`ok: true` 表示检查已完成，不证明脚本可直接生成或质量合格。`preview` 返回分包建议，不截断台词或超限镜头。

advisory 的 `compile` 仅写入 `shot_reviews/<episode>/shot_script.txt` 和 `review.json`，保留源脚本，不改动正式 `prompts`、`matches` 和 `episode_packages` 文件。这些检查草稿不是可直接生成的单集包。必需参数缺失、插件配置无效、输入不可读、资产清单 JSON 无效和写入失败仍会报错。

Muse 同时启用 `sessionVideoSelection: true`：分包建议采用当前会话所选视频模型及已知时长上限，不采用项目默认值或传入的 `max_submit_seconds`。参数冲突时返回警告。`duration_budget` 返回实际来源、上限与所选模型 revision。选择不可用或时长未知时返回警告，不给分包方案，绝不替用其他模型的 15 秒或 30 秒上限。

切换所选模型时，将最近一次实际 preview/compile 分包提交时长的比较追加到既有已记录选择上下文，点名超限包和镜头，不改系统提示词、不另发模型请求、不写文件或改卡。它不重读修改后的源稿或检查图片；需要新方案时应重跑 `preview`。按旧选择 revision 检查的迟到结果也会追加警告上下文。

插件默认仍为 `reviewMode: strict` 和 `sessionVideoSelection: false`，独立工作流保持严格编译与必需显式预算。结果通过 `review_mode` 返回模式，模型不能通过工具参数选择部署设置。现有镜头写作技能保持不变。

## 迁移

1. 完成正在运行的工作，再重启 Muse 加载当前短剧预设。确认 `drama_shot` 结果包含 `review_mode: advisory` 与 `duration_budget.source: session`，并核对返回的选择与会话视频模型菜单一致。
2. 阅读返回的警告，依据原剧本与实际项目决定创作修改。切换模型后重跑 `preview` 更新分包建议。不要把空 `failures` 列表、`ok: true` 或仅时长复核当成质量验收通过。
3. 在 `shot_reviews/<episode>/` 下查看检查草稿。继续通过平台工具预览、保存和回读实际视频卡，不把检查草稿当作正式编译的单集包提交。
4. 如果已有外部工作流需要 matched JSON 和正式单集包，保留或明确设置 `reviewMode: strict` 与 `sessionVideoSelection: false`，preview/compile 继续传入已核实的 `max_submit_seconds`。输出路径见[检查模式](../../../../packages/drama/tool-shot-script/README.zh.md#review-modes)，模型选择见[会话视频设置](../../../../packages/drama/tool-shot-script/README.zh.md#session-video-settings)。
