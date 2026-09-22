---
description: "通过可迁移的技能资源检索历史短剧资产、维护项目状态，并组装已确认的整剧交付。"
kind: "package-library"
---

# @deepseek-ai/dsh-drama-skills

[English](README.md) | 中文

## 摘要

这些技能资源用于创作和审核短剧脚本、复用资产、维护项目状态、准备可编辑草稿、渲染分集、组装整剧交付，以及认领剧变剧本池里新放出的剧本。入口是维护中的 `skills/*/SKILL.md` 文件，从总控技能开始。Python 脚本与必要静态资源一起分发。用户项目、凭据、媒体及本地运行环境不随包分发。

## 目录

- [使用本包](#use-this-package)
- [理解实现](#understand-the-implementation)
- [模型体验](#model-experience)
- [已知限制与待办](#known-limitations-and-deferred-work)
- [开发备注](#dev-note)

-----

<a id="use-this-package"></a>
## 使用本包

解析本包的 `package.json`，再把同级 `skills` 目录交给现有技能加载器。本资源包不注册 Service、Tool 或插件。仅安装 npm 包不会激活技能。

从[总控](skills/tweet-drama-pipeline/SKILL.md)开始，调用脚本前读取相关技能。保留技能目录相邻：草稿、渲染和交付共用 core 的视频禁用检查。使用 Python 3.11 或更新版本。图片辅助模块需要 Pillow，文档辅助模块需要 python-docx，草稿生成需要 pyJianYingDraft；其他可选依赖由各技能说明。包内不附带 Python 解释器、依赖环境或 FFmpeg 二进制。

资产脚本优先使用 `JUBIAN_ASSET_LIBRARY_ROOT`，否则使用 `$DSH_HOME/data/jubian-asset-library`，其中 home 默认是 `~/.dsh`。已有 `tags.local_path` 不改写。检索只读。视觉标注维护需要显式注入 `DEEPSEEK_API_KEY`，可能产生费用；不读取 env 文件或 Jubian token。凭据提供方与子进程环境的接线由消费应用负责。

交付使用自带 `assets/template.json`。显式 `TWEET_DRAMA_TEMPLATE` 必须是已有目录；它不替换九目录名，也不导入第三方文件。组装会删除受管输出分区中的过期文件。项目内输出必须留在 `delivery` 下；项目祖先、上游重叠及已有输出内的链接会被拒绝。报告输出到 stdout，不写报告文件；复制不等于 SHA256 核对或完整媒体 QA。

剧本池查询与认领使用[抢本技能](skills/jubian-snatch/SKILL.md)。认领是真实的远端写操作，会把剧本归到调用账号名下。池子读取会翻页，读不完时如实报告，而不是把某一页当作整个池子。启动基线读取失败或读不全时，在发出任何认领之前就退出，认领范围不会因此被悄悄放大。每次认领都过两阶段本地账本：已确认或结果未知的剧本绝不重复提交。认领后的回读只认「行里写着本账号」这一种证据，剧本从池中消失不算。

在本包目录运行离线迁移检查：

```sh
npm test
```

-----

<a id="understand-the-implementation"></a>
## 理解实现

<details>
<summary>维护与打包</summary>

本目录是维护源码。初始输入来自操作者 `.dsh/skills` 中同名技能的指定 `SKILL.md`、`scripts`、`references` 及相关测试。仅保留这些 DSH 技能实际使用的依赖。已安装的个人副本保持独立，不自动同步。

`package.json#files` 逐文件列出分发内容，不使用家庭目录整树或宽泛目录 glob。包排除凭据、cookies、缓存、日志、虚拟环境、可执行文件、用户索引、媒体和第三方模板 PDF。测试只保留在源码中，不打包。无需运行时 invariant 伴随模块：本包拥有静态资源，没有可独立变化的运行时观测。

</details>

<a id="model-experience"></a>
## 模型体验

本包本身不增加模型调用。加载技能会把其指令加入消费会话；检索结果和脚本输出仅在调用方请求时进入上下文。付费视觉标注脚本仍是显式维护动作。项目模型规格与交付设置仍是依据。

<a id="known-limitations-and-deferred-work"></a>
## 已知限制与待办

- 当前 Web profile 仍需消费方显式配置技能加载器、凭据注入和 Python 依赖。本包不改变根配置，也不宣称正在运行的 Web 会话已使用这些资源。
- 尚未确认来源源码的再分发权利。`private: true` 与 `UNLICENSED` 避免清单暗示公开许可。本机 Web 使用不构成公开再分发授权。
- 当前 DSH 短剧工具负责模型目录、镜头编译、付费提交和凭据访问。本包不提供这些工具，也不恢复旧应用的独立状态文件。小红书访问需要另行配置 MCP 服务，登录态不分发。
- 迁移测试不执行提供方请求或真实项目组装。资产数据迁移须单独保留或显式重映射已存绝对路径。媒体 QA 和复制哈希核对仍由调用方负责。
- 抢本技能不随包分发 PyQt6 桌面客户端，也不含源项目的联网人工探针，两者仍是本机工具。其认领路径只有针对假传输层的离线测试覆盖，因此迁移期间没有发起过真实认领，也没有对线上服务做过端到端验证；账本、分页与回读规则同样只在离线得到验证。

<a id="dev-note"></a>
## 开发备注

无。
