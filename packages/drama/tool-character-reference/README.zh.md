---
description: "让 Agent 有界检索人物参考并查看经过校验的图片，不暴露存储位置，也不授予使用权限。"
kind: "package-reference"
---

# @deepseek-ai/dsh-tool-character-reference

[English](README.md) | 中文

## 概述

`drama_character_reference_project` 列出经 Host 校验的项目；唯一项目可自动选定，多个项目须由用户选择。`drama_character_references` 在项目圣经角色校验后，返回最多三张由 metadata 初排、带实测原图 SHA-256 的候选。`drama_character_reference_view` 按精确 Catalog ID 和 SHA 重读候选，图片身份变化时拒绝，只向支持图片输入的模型传递图片像素。检索不等于看图；模型不能提供路径或凭据。

Host 内部的 `characterReferenceAuthority` 供下游复核项目、角色、Catalog ID 和 SHA，不改变审核或授权状态。

这些只读结果不授予生成、复用、绑定、发布或跨项目使用权限。`pending_review` 仅可查看，不可用于正式制作。

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

如果 Session 的 `cwd` 本身是已配置项目根目录，Host 可以直接使用。工作区内只有一个经 Host 验证的有效项目时，也可直接使用，无需用户额外选择。Agent 可调用 `drama_character_reference_project action=list`，再用 `action=select` 读取唯一项目经圣经校验的角色 ID、名称、类型及已有项目主绑定资产 ID，不必提供本机路径。若有多个有效项目，用户必须在当前对话中明确指名其中一个，Agent 才能用 `action=select` 选定；列举与 `drama_project read` 都不能替用户作选择。只有这种明确的人类选择会保留在当前运行的 Session 中。后续人类消息如果指名其他项目，必须重新选定；恢复 Session 后不能沿用旧选择。Host 每次检索都核对项目身份和目录。项目缺失、歧义、变更或路径不安全时拒绝，不接受任意 `project_dir` 参数。

Agent 提供所选项目的 `character_id`、从剧本提取的 `role_description` 和 `role_class` 声明。Host 每次检索都通过 `readProjectBible` 重读项目圣经；角色不存在或声明与已登记的 `role_class` 冲突时，会在调用素材库前拒绝。若尚未登记类型，Agent 声明只可用于只读初排，结果会明确标注不确定性，不授予素材使用权。所有已登记角色都可检索；Agent 根据剧本判断参考图是否有用。可选的 `supporting_use_reason` 只记录剧情依据，不作为检索许可或素材使用授权。分类、年代、性别、风格、特征和角色关键词用于缩小内部检索范围。

`character_id` 表示项目角色，`catalog_asset_id` 表示素材库候选，`image_sha256` 标识原始图片字节。Agent 将候选中的后两项传给 `drama_character_reference_view`，可查看、比较、选择或放弃候选；这些身份与供应商资产 ID 也必须分开。

-----

<a id="understand-the-implementation"></a>
## 实现说明

<details>
<summary>实现细节——点击展开</summary>

[`src/index.ts`](src/index.ts)注册项目选择、有界检索、图片查看和 Host 内部的权威服务，在读取图片前核对当前模型路由的图片能力，并在返回图片块前把校验过的预览保存为 Session 附件。[`src/project-context.ts`](src/project-context.ts)只解析经 Host 校验的项目根目录，唯一有效的子目录项目可自动采用，多个项目时才需要用户明确选择。[`src/project-role.ts`](src/project-role.ts)通过公开的项目圣经读取器重读所选项目。[`src/authority.ts`](src/authority.ts)要求已登记角色类型，供下游 Host 消费者重读当前项目、角色、精确 Catalog 身份和原图 SHA-256，不修改审核或授权状态。[`src/reference.ts`](src/reference.ts)校验模型声明、核对已登记角色类型，只投影有界 Catalog 字段而不暴露存储 key。

</details>

-----

<a id="model-experience"></a>
## 模型体验

### `drama_character_references` 工具

#### 模型看到什么

`drama_character_references` 的结果最多包含三个 Catalog 身份、原图摘要、匹配证据、不确定项及明确的禁止使用标志，不包含图片块。`drama_character_reference_view` 返回一张图片块及其稳定 Catalog ID、原图摘要、当前 metadata 状态和不可绑定标志。Agent 可凭图片选择或放弃，但不能把候选说成已批准或已绑定。

#### Token 影响

固定 schema 增加三个有界工具定义。项目列举最多返回 64 个项目 ID 和标题；选定项目的角色清单最多 128 条。检索最多返回三条简短候选记录；每次明确看图会在模型上下文中增加一张图片，受部署附件和模型限制约束。

#### KV Cache 影响

工具调用和结果追加到对话。schema 变化会影响可复用请求前缀；检索文字和查看的图片块只影响后续模型请求。模型附件可能经过规范化，但报告的原图 SHA-256 始终标识源字节。

## 已知限制与后续工作

<a id="known-limitations-and-deferred-work"></a>

- Host 管理的素材库及其部署 provider 必须已配置；本包不会回退到本地草稿、任意文件或调用方指定的对象存储位置。
- 当前 Agent Session 必须位于已配置项目根目录、工作区下唯一有效的项目，或在多个项目中有用户确认的选择。圣经必须包含请求的稳定角色 ID；缺少角色类型时，可根据 Agent 声明进行标注不确定性的只读检索，但下游素材使用授权仍要求已登记角色类型。本工具不会修复项目数据。
- 图片查看要求持久附件服务，且当前精确模型路由明确支持图片输入。文字模型可以检索，但不能声称已经看过图片。
- 本包不上传素材、不发布 metadata、不修改审核状态、不绑定项目角色、不调用供应商，也不发起付费生成。
- `pending_review`、`approved_claim` 等 metadata 状态都只是描述性声明。本工具不能证明版权、复用权、项目批准或正式制作适用性。
- 角色重要性指导 Agent 是否检索，不进入 catalog metadata，也不是业务服务的检索门禁。剧情依据不授予素材使用权限。
- 真实 Agent 验收和后续审批到绑定的链路仍需独立端到端证据。

<a id="dev-note"></a>
### 开发备注

两种语言的 README 修改后，使用仓库 translation-pairing 生成器重新生成 `README.i18n.yaml`。
