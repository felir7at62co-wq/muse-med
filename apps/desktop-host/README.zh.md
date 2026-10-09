---
kind: package-reference
description: "Muse Desktop Host 的产品配置与智能体预设默认值。"
---

# Muse Desktop Host

[English](README.md) | 中文

私有 Host 为[桌面应用](../desktop/README.zh.md)提供 Muse 组合。内置预设文件使用普通 Cordis 配置。用户自有模型提供方与凭据独立于 Muse 账号目录。

桌面账号组合通过 [`excludedProviderIds`](../../packages/host/muse-account/README.zh.md#minimal-configuration) 排除独立 Gemini 提供方 `aa`。账号选择器保留云映的 `gemini-3.1-pro` 及其其他供应模型，以及官方 DeepSeek。已有对话若选用了独立 Gemini，须在下次请求前选择可用模型；操作见[迁移指南](../../docs/upgrade-guide/v0.2.1-alpha.1/muse-gemini-provider/guide.zh.md)。

桌面账号组合将网关与知识库请求的 `requestTimeoutMs` 设置为 60,000 毫秒，包含项目参与组合扫描。个人覆盖文件可修改这一经过验证的账号配置；底层插件默认值仍为 15,000 毫秒。超时仍报告服务不可用，不能据此判断远程写入是否完成。

<a id="compaction-defaults"></a>
## 压缩默认值

Host 默认值与 `standard`、`ptc`、`cordis`、`short-drama`、`editing` 预设为[选定目录](../../services/muse-accounts/README.zh.md#selected-model-budgets)中的账号模型声明精确策略。每条策略预留 16,384 tokens 的额外压缩余量，将摘要上限设为 8,192 tokens；正常对话保留提供方输出预算。其他路由继承后端默认值；`minimal` 不挂载自动压缩。

每个创作预设拥有隔离的压缩后端，因此策略同时位于各预设的 `agent.cordis.yml` 和 Host 默认覆盖文件。个人预设可按[压缩配置](../../packages/compaction/compaction-basic/README.zh.md#tuning-when-condensation-starts)设置自己的 `modelPolicies`。后端将固定请求成本计入预算，并在相关输入改变前跳过未改变的失败选区或单独检查点的重复摘要。

<a id="video-screenplay-delivery"></a>
## 视频剧本交付

编剧与短剧路由要求通过 [screenplay-project](../../packages/drama/screenplay-project/README.zh.md) 先整理视觉事实，再逐集独立审校并顺序验收。受管视频项目使用 `workflow: video_to_screenplay` 和 `qa/screenplay-project.json`；正式文件位于同级 `final/` 目录。分块场景文件和持久化覆盖清单支持恢复，不依赖压缩后的对话摘要。

`screenplay_export_docx` 在转换前将每份受管输入与当前已验收 Markdown 比较，固定这些正文，并生成 `.docx.screenplay.json` 记录，绑定候选与输出摘要。可选 `project` 参数使跨目录导出保持绑定；显式项目不存在或未标记时拒绝导出。Office 组合还注册实际 `present` 执行器检查：受管 Markdown 须匹配验收，Word 须有匹配记录，并通过内置 Python 将实际正文与当前已验收正文独立比较。项目身份使用文件系统真实路径，使目录别名保持同一验收。替换正文或在表格中追加内容，即使伪造匹配记录也会失败。普通 Python 或 Office 生成的文件未经候选验收时，不能声明为受管视频正式交付。普通文档和没有视频标记的项目保留原有转换与交付行为。

默认范围依赖约定的标记和目录；未标记项目，或移出范围且没有记录的文档，无法被识别为视频转剧本。文件系统权限仍可编辑项目与校验文件；这些是一致性记录，不是签名授权。直接文件链接和外部应用不调用 `present`。独立审校仍负责已整理清单之外的画面完整性与含义，检查不能证明抽样找到了全部事件。
