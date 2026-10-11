---
name: tweet-drama-shot-asset-match
description: 仿真人镜头与剧变正式资产匹配。逐镜头绑定确认出演的人物服装版本、动物主体、场景和道具，输出带 Jubian asset/material ID 与 URL 的 matched JSON。
---

# 镜头正式资产匹配

镜头设计与资产选择是一个逻辑阶段。写每镜时就从当前剧变项目“主体设定”的实时父资产中确定角色服装版本、场景状态和关键道具，禁止从本地候选目录、旧分镜、历史视频或名字相似项猜图。

逐镜明确 `出镜人物`：名单决定入画的人类角色，台词提到的人、画外说话人不因此绑定。没有名单才从画面动作与主体追踪确定入画者。把称呼通过资产清单的 `aliases` 解析到正式角色，再按本集 `episodes` 与角色身体状态选择唯一服装版本；具体完整名优先于它内部命中的短名，不能把同一角色的多个版本一起挂上。`drama_shot` 返回 `asset_binding_ambiguous` 时列出候选父资产 ID 与状态，补明确资产名或修正登记，继续其他独立镜头；不按目录顺序猜。`unregistered_character` 先补正式资产登记或更正出镜名单。右手、脚部、背影与姿态描述可沿用该角色的已登记版本，不因身体局部或动作字词单独要求新资产或新状态。

每包检查全部入画实体，包括反复出镜的动物；不能只检查人的名单。画面或主体追踪写「目光落在小鸡身上」「小鸡啄米」时，小鸡需要该项目当前正式动物资产和 `@[正式名](key)`，不能用场景或人物图代替。清单以 `type: "动物"` / `"animal"`，或角色行的 `subject_kind: "animal"` 明确标记动物，登记「小鸡」等 `aliases` 与实际 `episodes`；已有首集素材也要核实本集覆盖并加入本包素材名与 key。动物不填写人的孕期、年龄、服装来通过门禁，但仍须官方确认、实际父资产与素材 ID、URL；画外或纯台词提及不绑定。多个动物版本用完整资产名或明确适用集数确定唯一；漏登记先补料，不把资产名字猜成动物或拿相似图顶替。

`drama_shot preview/compile` 返回每包完整 `prompt`，保留镜头正文并补齐已确认绑定的人物、动物、场景、道具的 `@[正式名](key)`。已有 key 复用，缺 key 时采用稳定的 `asset_<jubian_asset_id>`；不得改用正文哈希或删掉动作、视线、台词来重建提示词。直接把返回的完整 `prompt` 保存到 `modelConfig.prompt`，按 `material_keys` 首次出现去重的顺序组装同一批父资产 selections，并核对实际回读。`material_names` 是绑定资产名列表，不能靠与 keys 下标拼接猜映射。

**先写角色状态卡，再绑定；状态卡是机器可校验的字段。** 每个角色每集先写明本集**体型**（孕周、年龄段等）、服装版本、发型和时段，全部取自剧本原文或已确认大纲；剧本写明孕周的，状态卡记下那个周数。状态卡落到实处就两处，两处都要写：

1. **镜头侧**：每个入画人类主体的 `主体状态追踪` 段落里写一行 `身体状态：【阶段；服装；发型】；`（与 位置/动作状态 同级，不带角色名前缀）。没有体型变化也要写 `非孕期`。
2. **资产侧**：`assets_manifest.json` 的每个人类角色行写 `episodes`（具体集号数组，如 `[25]`；全剧通用母版写 `["all"]`）和 `state_or_costume`（阶段/体型语义 + 服装，如 `孕早期（孕八周）、孕期职场装、长发`）。

`drama_shot` 的 `validate`/`preview`/`compile` 会逐镜比对两侧：孕期阶段与年龄段必须写同一组且同值，服装/发型等文字必须能在资产登记里找到；只有一侧写了就是未标阶段，直接判失败并点名资产 id 与修法。设定板是孕晚期身形、剧本写孕八周，就是挂错了版本——**不得因为资产名带「孕期」就照用**。清单里根本没有该状态的版本时，结果会给出补料需求（角色/阶段/服装/用于哪几集）与补料路径：从 `jubian-asset-library` 复用，或生成后登记，再跑 `drama_assets reconcile`，然后重新校验。跨集跨越时间（「数月后」「五年后」）时状态卡按集变化。`preview`/`compile` 带上实际 `episode`，根据同次结果的 `failures` 换资产或补资产，根据 `warnings` 复核；单独 `validate` 按需使用。

每个绑定至少包含正式名、类型、适用集和场、视觉提示词、数字 `jubian_asset_id/materialAssetId`、剧变 URL、`official=true` 和主体设定实时详情证据。生成资产还必须包含 `jubian_material_id`、确认时间和确认出演响应；`isLocal=1` 的主体设定直接上传资产可以没有生成 material ID，但必须属于同一 `scriptId`、`delFlag=0` 且实时父资产 URL 有效。

matched JSON 只能记录主体设定当前版本；分镜中的 `materialAssetId`、`assetId`、URL、名称/缩略图和提示词映射必须共同指向该版本。生成资产的字符串 `assetId=asset-...` 不得当作父资产查询 ID。

候选图、仅自动审核通过的生成图、缺确认响应的生成图一律拒绝。人物必须选择当前场次正确服装和阶段；场景、道具必须符合当前时空。同一镜头引用顺序必须和视频提示词中的人物映射一致。出现新旧字段混合、已删除资产或缺少核心资产时，回到主体设定重新选择或资产生成与确认出演，不得用相似图顶替。

## 绑定前集中核对

优先通过 `drama_assets match_preview` 汇总本集人物与场景复用建议，输入与状态见 [匹配预览字段](../tweet-drama-core/references/match-preview.md)。同名、缺少既有角色身份关系、服装/身体状态冲突或场景条件不足不得当作匹配成功；`blocked` 暂停受影响项，`needs_review` 集中提交人工确认。当前项目的 `missing` 不等于历史库无素材。`reuse_ready` 不批准正式采用，也不写分镜；人工确认后仍按原 `drama_shot` 校验和 `select_assets` 实时身份/顺序回读绑定，不跳过既有门禁。

### 集中复用计划

多镜头选材按「匹配预览 → 复用建议 → 用户确认 → 模型调用原有 jubian_storyboard.select_assets」处理。先用 `drama_assets method=reuse_preview`，复用 requirements_path；有已建分镜时可传 plan_path，按稳定身份、状态及条件集中展示 groups、候选和原因。needs_review 先澄清并重做预览，missing 继续既有素材库检索，blocked 停止受影响项。输入和绑定参数见[匹配预览字段](../tweet-drama-core/references/match-preview.md#用户确认后使用现有绑定工具)。预览不审批、不写关系、不自动绑定；reuse_ready、already_bound 和 fingerprint 不是用户授权，apply_allowed=false 只表示预览本身不授予写入权限。取得覆盖具体项目、分镜和素材版本的真实用户授权后，模型可以调用原 select_assets；同一身份状态与适用范围的确认可用于已列出的多镜头，来源、状态或计划变化后重新核对。禁止 Agent 自填 approved，未授权不得绑定；继续原 drama_shot、素材身份、顺序、幂等和回读校验，声线仍走 audio_preview → audio_apply。
