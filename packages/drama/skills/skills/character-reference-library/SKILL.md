---
name: character-reference-library
description: Use when a short-drama role needs a public character reference, when reviewing a recommended reference, or before using an approved reference in Jubian image generation.
---

# 公共人物参考库

公共人物库提供可复核的创作参考，不提供已经确认出演的剧变资产。先用 `drama_project action=read` 读取项目角色；角色身份只使用稳定 `character_id`，素材身份只使用 `catalog_asset_id`，供应商身份只使用远端返回的 ID，三者不得互换。

## 检索、看图与自主选择

为每个角色记录项目权威的 `role_class`，不要把角色类型写成 Catalog 素材属性。`lead` 默认可以检索人物库；`important_support`、`support` 和 `extra` 默认跳过。剧情确实需要配角复用人物参考时，必须把具体剧情依据作为 `supporting_use_reason` 交给工具，不能用“更好看”“库里有图”作为理由，也不能把该理由写回 Catalog metadata。

先用 `drama_project action=read` 建立当前项目上下文，再从剧本和项目圣经提取角色需求并调用 `drama_character_references` 获取有限候选。工具请求只包含 `character_id`、角色描述、角色类型，以及已经明确的年代、风格和可观察特征；它不接受项目路径、本地索引路径或任意 TOS key。不要编造缺失特征。文字评分只用于初排，不代替人物面容判断。

按角色需求自主决定查看哪些候选；从同一候选结果取得 `catalog_asset_id` 和 `image_sha256`，把后者原样作为 `expected_sha256` 交给 `drama_character_reference_view` 获取实际图片内容块，不编造摘要或用后来返回的新摘要代替原选择。再根据看见的面容和角色要求选择或放弃。不要把文字推荐、图片文件名或未打开的预览当作已看图，也不要按分数、编号或目录顺序机械选中。可以在有必要时继续检索或查看，不规定固定调用次数。说明选择理由、不确定项、当前审核状态与稳定的 `catalog_asset_id`；没有可靠匹配、看图失败或工具不可用时如实说明，不把候选列表交给用户代替 Agent 判断。

`pending_review` 可以参加推荐，但仍不可发布、复用、绑定或发送给供应商。推荐结果只是参考，不能写成“已批准”“已绑定”或“可直接使用”。

## 审核与项目绑定

人物参考工具的推荐不构成审批。只有部署已经提供明确的库级审核结果和项目级使用批准，并且批准记录同时绑定同一项目、`character_id`、`catalog_asset_id`、图片 SHA-256 与当前审核指纹时，才可以继续项目绑定。跨项目、跨角色、图片摘要变化、审核指纹变化或已经拒绝、撤销的记录全部失效。不要自动批准上传后仍为 `pending_review` 的素材；缺少上述权威状态时停止在推荐阶段。

没有有效审批时不得调用 `jubian_asset upload_reference`，不得把人物库图片放进 `jubian_video image_generate` 或批量生图的 `references`。审批通过后仍只把人物库图片作为生成参考；生成图需要单独视觉审核、`confirm_casting` 回读和正式资产登记，人物库记录本身不成为正式出演资产。

## 只读范围

当前人物库只提供检索与看图，不提供入库、审核或项目绑定工具。人物匹配任务不以入库为前置。用户要求新增素材时如实说明当前能力，不声称已经写入 TOS，也不把本地草稿或测试数据描述成云端素材。

## 安全边界

人物库工具不得删除、移动、复制或公开分享云端对象，不生成签名 URL。搜索、预览和推荐不调用付费供应商。剧变上传与生图沿用现有预算、幂等、实时目录和未知结果门禁；审批不能替代这些门禁。
