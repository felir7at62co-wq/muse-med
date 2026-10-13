# 项目数据与交接

以下是本技能的独立本地格式，不声称兼容任何现有平台的输入 schema。若接入已有制作系统，以该系统的权威清单为准，建立字段映射，不维护两份会分歧的“当前正式版本”。

## 建议目录

```text
project/
  project.json
  asset-index.json
  shot-bindings.json
  changes.jsonl
  assets/CHAR-001/base/r001/
    record.json
    design.md
    prompt.txt
    review.json
    media/
```

模板中的空值是待填写字段，不代表已具备资产；最终交付时保留真实的未完成状态，并列出缺项。所有 JSON 使用 UTF-8；项目内部文件使用相对路径，搬迁时从项目根解析。外部引用单独标注为外部，不把操作者机器绝对路径写成可移植路径。

## 权威记录

- `project.json`：`schema_version`、`project_id`、`deliverable_type`、`style_revision`、风格与交付规格、实际已覆盖剧本范围。已有项目设定文件时沿用该文件并记录映射。
- `asset-index.json`：`schema_version=1`、`manifest_revision` 和 `assets` 数组。每行含 `asset_id`、`name`、`aliases`、`type`、`variants`；每个变体含 `variant_id`、`current_revision` 和 `revisions` 路径列表。当前指针为 null 表示尚无采用版本。
- 各修订 `record.json`：按资产模板保存。`revision` 在同一资产变体内唯一；`parent_revision` 指向被修改的修订，初始为 null。状态仅在此记录，不在索引复制一份。
- `shot-bindings.json`：`shots` 数组，每行 `shot_id`、`episode`、`scene`、`assets`；资产引用明确写 `asset_id`、`variant_id`、`revision`。`needs_review` 与 `reason` 用于受影响镜头，不能伪称自动完成重制。
- `changes.jsonl`：每行记录 `change_id`、真实时间、作用对象、`from_revision`、`to_revision`、原因、修改和保留字段、受影响镜头、采用依据。只追加，不将回退写成删除历史。

## 修订字段

`type` 取 `character/creature/scene/prop/effect`。`episodes` 是整数数组或 `["all"]`，空数组表示范围未确认；`scenes` 保存实际场次 ID。`script_evidence` 保存集、场和原文依据，不发明不存在的台词。

`identity` 保存该资产不可无意改变的视觉特征，`state` 保存本变体的服装或状态。`dependencies` 使用明确的项目、资产、变体和修订引用，例如服装版依赖已通过的人物身份母版。

`source` 记录 `original/reference/derived`、来源项目与修订、可用路径或链接及使用依据。未知字段为 null，不虚构作者或许可。

`generation` 记录最终提示词、参考图角色、实际模型与参数、尝试编号及任务结果。提交前缺少的模型或任务 ID 可为 null；提交后必须用实际结果填入。未知任务保持 `unknown`，原 key 回查；修正新尝试保留旧尝试，不覆盖计费证据。

`files` 每项记录 `path`、`role`、`sha256`，可补充实测宽高与文件格式；只有实际计算才能填写摘要。`role` 区分面部、正面、侧面、背面、场景、源工程、导出模型等，不能把 JPG 写成模型。

`review.result` 取 `not_checked/pass/fail`，`checks` 每项记录维度、结论、可观察证据及文件路径。`adoption.status` 取 `candidate/adopted/retired`，`basis` 记录实际采用依据。被新版本替代不自动使旧版不可用于历史镜头。

`remote` 为可选平台映射：真实平台名、项目 ID、资产 ID、素材 ID、URL、确认及回读证据。默认 null。没有远端集成时可采用本地资产，但不能写平台的 `official=true`。

## 交付前校验

确认 ID 和修订唯一、当前指针和依赖存在、绑定不含 `latest`、文件可访问、摘要与实际文件一致；确认采用版审核通过且有采用依据。检查每一项未完成记录是否有明确缺项；检查新修订没有覆盖旧文件，修改记录与影响范围一致。

没有生成文件的纯规划交付可以通过结构检查，但必须保持 candidate、not_checked 和空当前指针。模型源文件必须经过相应软件打开与操作验证，不能只检查扩展名。

数据结构变更时递增 `schema_version` 并提供旧到新的映射；新资产修订只增加 `revision`，不因此改变 schema。首次迁移保存原清单副本，不静默丢弃旧字段或历史引用。

## 版本 1 到版本 2

项目和资产模板使用 schema 2；未变的索引与镜头绑定格式继续使用 schema 1。项目新增 `style_lock`，资产新增 `style_family`、`review.style_gate` 与 `review.quality_checks`。这些是本技能数据，不是未核实的平台 API 参数。

`style_lock.family` 与新资产 `style_family` 为 `3d_anime`。`style_gate` 记录 result 与证据；`quality_checks` 每项记录维度、pass/fail/not_checked、证据和文件路径。只有风格和全部适用关键质量项通过才可将 `review.result` 设为 pass；旧 `checks` 保留其他检查，不能替代新画风验收。

迁移先保存原文件。旧项目存在风格冲突时，新增风格修订及锁定字段，保留旧风格历史。旧资产修订不就地改动漫标签；需要纳入新生产时创建 schema 2 修订，保留原字段和文件引用，将新增审核标为 not_checked，实际看图后才能确定风格通过。新修订先保持 candidate，不移动当前指针。历史采用状态与镜头引用保留，但不能冒充已通过本次新标准。

时代依据沿用 `style.world_and_era`、`script_evidence`、设定卡和 `review.quality_checks`，按 [时代一致性规则](era-consistency.md) 记录 `era_consistency`。下沉可读性记录 `market_readability`。两项均使用既有检查结构，不改变 schema 2；旧修订未经实际复核不得声称通过新增标准，重新采用时创建候选修订并补充审核。


图二对照与人物版式按 [严格交付审查](reference-standard.md) 执行；reference_style_match、delivery_layout、aspect_ratio 沿用 quality_checks 的 result、证据和文件路径，不改变 schema。generation.references 记录可访问的目标图片及实际提交标识，哈希必须实测；旧资产未经新标准复核不得自动标记通过。

场景环境状态审核 scene_condition 沿用 review.quality_checks，不改变 schema；时代与画风匹配分别沿用 era_consistency、cross_asset_style_consistency。场景默认 16:9，其他比例的使用者明确指定或询问答复记录在设计卡及 generation.prompt_parts 中，最终比例与实际尺寸记入生成参数和文件实测信息；成片比例不能替代该依据。

每次调用的流程证据按 [主技能的完整交付流程](../SKILL.md) 写入既有 review.checks：workflow_01 至 workflow_07 使用维度、result（pass/fail/not_checked）、证据和文件路径。不新增 schema 或第二套状态；适用步骤未完成不得宣布整批交付完成，生成未知和未看图均不能标记通过。

face_design_compliance 使用既有 review.quality_checks 记录脸部设定符合性和图二近似脸污染检查；delivery_layout 的证据分别记录 A 半身与 B/C/D 身体视图，不能以一条整板通过替代逐格无头检查。保持 schema 2。

五官差异方案沿用设定卡、identity 与 generation.prompt_parts 记录，参考分工写入 generation.references；face_design_compliance 的证据包含实际对照过的角色／候选修订及图片路径、结构差异和未能比较的范围。同一已采用身份的连续性与不同身份的差异性分开审核，schema 保持 2。

面部四组结构对照沿用 identity、设定卡和 generation.prompt_parts；比较覆盖范围、未覆盖历史、实际提交核对状态写入 face_design_compliance 的既有证据字段。不得新增强制顶层字段或改变 schema 2。

## 本地结构检查

场景规划使用既有 `generation.prompt_parts.scene_continuity`，字段含义按 [场景继承](scene-continuity.md)。`dependencies` 可补 `purpose=scene_parent/identity_parent`，依赖仍以完整项目、资产、变体和修订定位；同角色换装的稳定 `identity` 与 identity_parent 一致。`generation.references` 的用途与内容声明按 [参考分工](identity-and-grounding.md)，`edit_source` 和既有 `edit_base` 同样记录待修底图。以上都是既有开放对象中的本地记录，不改变模板 schema 2，不自动迁移或重标历史资产。

从本次加载的技能目录运行 `python -B scripts/validate_asset_records.py --project-root <项目根> <record.json> <依赖record.json> ...`，检查完整本地依赖集合，记录路径可明确传入，媒体路径使用项目内相对路径。跨项目复用先在目标项目建立派生记录，源项留在 `source`；不将两个项目媒体根混为同一个根。缺图的纯规划记录保持 candidate/not_checked/files=[]，结构检查可以通过；文件一旦登记就必须存在且 SHA-256 与实测一致。

脚本检查 ID 与明确修订、重复和缺失依赖、前版 parent_revision、依赖环、角色身份固定项、场景机位／环境变化范围，以及同记录 identity/state 与场景计划的同名字段冲突。已提交的本地参考声明包含 path 时检查存在性与摘要，远端引用仍需实际回读；参考用途声明与审核声明分别检查。声明 review.result=pass 时 style_gate 和所有已列适用检查须为 pass 并有非空证据；场景还须有 scene_clean_plate、scene_reference_isolation、scene_continuity。采用必须有通过记录、依据及通过的依赖，脚本不填补缺项、不移动指针、不覆盖文件。规则拒绝绝对媒体路径、URL、NUL 或逃出项目根的路径；外部来源链接放 source，实际文件经项目归档后再登记。

输出为 JSON，包含 `structure_valid`、`visual_review=not_performed`、记录数和错误列表；发现结构错误或无效 JSON 返回退出码1，否则0。该结果不判断像素、时代、所有必查维度是否齐全、证据陈述真假、参考实际上传内容、模型可编辑性或平台正式状态。上述检查仍按完整技能流程执行，不能用补写 pass 和证据文字绕过真实审核。可执行示例见 [白天与雨夜记录](production-examples.md#同机位雨夜派生版)。

## 生成提交检查

在生成前按[首轮提交检查](first-pass-cg.md#提交前检查)记录正向媒介、完整最终文本及参考上传状态，运行 `scripts/validate_generation_request.py` 对账即将调用的完整工具参数。结构校验通过不表示允许生成；参考上传失败或最终参数改变时须停止并重新检查，不能移除失败参考以伪造就绪。检查只读取既有 schema 2 的开放对象，不修改历史记录或平台参数。
