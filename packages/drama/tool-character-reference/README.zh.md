---
description: "让 Agent 有界检索人物参考并查看经过校验的图片，不暴露存储位置，也不授予使用权限。"
kind: "package-reference"
---

# @deepseek-ai/dsh-tool-character-reference

[English](README.md) | 中文

## 概述

`drama_character_references` 返回最多三张由 metadata 初排、带实测原图 SHA-256 的候选。Host 在访问素材库前，通过 Agent Session 的 `project_config.json` 核对角色和所声明的角色类型。模型不能提供存储位置或凭据。`drama_character_reference_view` 按 Catalog ID 重新读取候选，图片身份变化时拒绝，并且只向支持图片输入的模型返回持久图片块。只有文字检索不等于已经看图。

所有结果都禁止发布、复用、绑定和应用。`pending_review` 素材可以辅助选择，但仍不可用于正式制作。

## 目录

- [使用本包](#use-this-package)
- [实现说明](#understand-the-implementation)
- [模型体验](#model-experience)
- [已知限制与后续工作](#known-limitations-and-deferred-work)
- [开发备注](#dev-note)

-----

<a id="use-this-package"></a>
## 使用本包

仅在已经提供 `tools`、`settings` 和只读 `characterLibrary` 服务的 Host composition 中挂载本插件。本插件没有路径、TOS 位置、上传、写入或供应商操作配置。

Agent 提供当前项目的 `character_id`、从剧本提取的 `role_description` 和 `role_class` 声明。Host 只从当前 Session 的 `cwd` 获取项目根目录，通过 `readProjectBible` 读取已验证项目圣经；工作区缺失、项目未配置、角色不存在、角色未持久化 `role_class` 或声明冲突时，都会在调用素材库前拒绝。主角默认可以检索。任何非主角都由 domain 服务默认跳过，只有 `supporting_use_reason` 给出有长度限制且与剧情相关的例外理由时才检索。可选的分类、年代、性别、风格、特征和角色关键词用于缩小内部检索范围。

`character_id` 表示项目角色，`catalog_asset_id` 表示素材库候选，`image_sha256` 标识原始图片字节。Agent 将候选中的后两项传给 `drama_character_reference_view`，可查看、比较、选择或放弃候选；这些身份与供应商资产 ID 也必须分开。

-----

<a id="understand-the-implementation"></a>
## 实现说明

<details>
<summary>实现细节——点击展开</summary>

[`src/index.ts`](src/index.ts)注册有界检索和图片查看，在读取图片前核对当前模型路由的图片能力，并在返回图片块前把校验过的预览保存为 Session 附件。[`src/project-role.ts`](src/project-role.ts)通过公开的项目圣经读取器解析 Session 工作区。[`src/reference.ts`](src/reference.ts)校验模型声明、要求权威值严格匹配，只投影有界 Catalog 字段而不暴露存储 key。

</details>

-----

<a id="model-experience"></a>
## 模型体验

### `drama_character_references` 工具

#### 模型看到什么

`drama_character_references` 的结果最多包含三个 Catalog 身份、原图摘要、匹配证据、不确定项及明确的禁止使用标志，不包含图片块。`drama_character_reference_view` 返回一张图片块及其稳定 Catalog ID、原图摘要、当前 metadata 状态和不可绑定标志。Agent 可凭图片选择或放弃，但不能把候选说成已批准或已绑定。

#### Token 影响

固定 schema 增加两个有界工具定义。检索最多返回三条简短候选记录；每次明确看图会在模型上下文中增加一张图片，受部署附件和模型限制约束。

#### KV Cache 影响

工具调用和结果追加到对话。schema 变化会影响可复用请求前缀；检索文字和查看的图片块只影响后续模型请求。模型附件可能经过规范化，但报告的原图 SHA-256 始终标识源字节。

## 已知限制与后续工作

<a id="known-limitations-and-deferred-work"></a>

- Host 管理的素材库及其部署 provider 必须已配置；本包不会回退到本地草稿、任意文件或调用方指定的对象存储位置。
- 当前 Agent Session 必须有现存工作区，并且项目圣经必须包含请求的稳定角色 ID 和已持久化角色类型。本工具不会推断这些字段，也不会修复项目数据。
- 图片查看要求持久附件服务，且当前精确模型路由明确支持图片输入。文字模型可以检索，但不能声称已经看过图片。
- 本包不上传素材、不发布 metadata、不修改审核状态、不绑定项目角色、不调用供应商，也不发起付费生成。
- `pending_review`、`approved_claim` 等 metadata 状态都只是描述性声明。本工具不能证明版权、复用权、项目批准或正式制作适用性。
- 非主角规则归业务服务所有，不进入 catalog metadata。配角例外理由只允许检索，不授予使用权限。
- 真实 Agent 验收和后续审批到绑定的链路仍需独立端到端证据。

<a id="dev-note"></a>
### 开发备注

两种语言的 README 修改后，使用仓库 translation-pairing 生成器重新生成 `README.i18n.yaml`。
