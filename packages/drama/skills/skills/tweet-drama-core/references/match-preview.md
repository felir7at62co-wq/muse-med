# 当前项目人物、场景与声线匹配预览

`drama_assets method=match_preview` 读取当前项目清单、项目圣经、完整远端资产/主体设定和必要的认可声线清单；远端只用 GET，本地不写文件。输入准备属于原有 Agent 文件写入授权范围，不由预览工具写入。本工具仅检索当前项目，不执行历史素材库检索。

## 调用与输入

传 `project_dir` 和项目内的 `requirements_path`。需求 JSON、原文及声线来源文件必须位于该项目内，禁止路径或符号链接逃逸。正式 DOCX 先沿既有剧本导入流程形成可追溯的分集文本，不把二进制 DOCX 当作按行文本。

```json
{
  "version": 1,
  "source_path": "episodes/01.txt",
  "source_sha256": "实际原文文件的64位SHA-256",
  "requirements": [
    {
      "id": "EP01-character-01",
      "kind": "character",
      "name": "阿舟",
      "character_id": "已登记的稳定角色ID",
      "episode": 1,
      "state_or_costume": "非孕期；青年；职场装",
      "conditions": ["总裁"],
      "source_line": 1,
      "source_text": "该行原文，保持空格及标点"
    }
  ]
}
```

每项必填唯一 `id`、`kind`（character/scene/voice）、`name`、`conditions` 数组、`source_line`（从1开始）与精确 `source_text`。工具核对原文文件摘要与逐行引用；这些检查发现来源变化，不代替人物身份、剧情含义和提取正确性的人工核查。

人物复用需已有项目圣经 `character_id` 关系或已登记 `stable_id`，并写实际 `episode`、`state_or_costume`；名称/别名只能召回候选。人物条件只读资产的 `identity`、`state_or_costume`，不把提示词当作已实现的视觉事实。服装状态采用保守的规范化文字一致比较，不能把不同孕期或身份判成同一版本。

场景复用需已有场景 `stable_id`、实际 `episode` 和非空条件。条件逐项与已登记 `scene_conditions`、`state_or_costume` 或 `identity` 的完整词项匹配，不从普通车厢提示词推断存在三个空座，不把否定句中的词项当正向命中。缺登记条件时交人工核查，不自动填造新条件。

声线使用项目圣经 `character_id` 和当前 `voice_profile`；还需现有 `audio/voice-references/manifest.json` 的 `samples`。引用样本须为唯一 approved 版本，资产ID、URL、摘要、时长与当前档案一致，并有可读取的 `source_path`、`source_sha256`、`start_seconds`。它复用已有认可记录，不签发新试听审批。空 `samples` 代表已检查无记录，缺文件或读不全代表阻断。

## 输出与处理

| status | 意义 | 后续 |
|---|---|---|
| reuse_ready | 已登记关系、所需条件及当前项目来源证据吻合 | 汇总复用建议，正式采用仍由人工确认 |
| needs_review | 同名、歧义、未认可、状态/条件冲突或身份/来源证据不足 | 展示候选与原因，人工处理 |
| missing | 完整当前项目查询未找到对应候选或认可声线 | 继续既有历史库检索，不直接生成 |
| blocked | 文件、项目、来源或分页无法可靠核对 | 暂停受影响项并查明原因 |

结果包含 `matches`、`counts`、`reason_codes`、证据摘要和 `search_scope=current_project`。`selected_asset_id` 是建议ID，不是远端绑定。`read_only=true`，付费请求及本地/远端写入次数均为0。预览不产生 `ready` 对账证据、不写 official=true、不改已有审批或声线，不绕过 `select_assets`、`audio_preview/audio_apply` 和 `prepare_video`。

当前工具不自动下载/标注历史库、不自动生成、不自动批准正式素材，不对图像质量或跨镜声音一致性作通过判定。库缺失、来源变化或查询失败不能改成 missing。原文、资产与声线修改后重做预览；实际绑定时仍由原工具核对实时身份、顺序、指纹和回读。

## 集中复用与分镜预检

调用 `drama_assets method=reuse_preview`，沿用 `requirements_path`，可选 `plan_path`。预览按稳定身份、状态、条件及选择归组；同名且身份未核实的需求不合并。`groups` 列出候选、适用集号和复用状态，每组 `approval_required=true`。声线仅列建议，不由图片主体绑定计划自动写入。

`plan_path` 是项目内只读输入，格式如下；不接受 approved、approval_id 等权限字段。`episode` 为原文集号，`episode_id` 为已有后台分集ID，两者不能互换。

```json
{
  "version": 1,
  "shots": [
    {
      "storyboard_id": 901,
      "episode": 1,
      "episode_id": 91,
      "bindings": [{ "requirement_id": "EP01-character-01", "material_key": "lead" }]
    }
  ]
}
```

工具 GET 回读分镜，核对项目、分集ID、Prompt 身份和素材顺序，复用现有 select_assets 构造器生成整卡建议。未指定修改的图片与参考音频按 `materialKey` 保留所有字段，包括身份和各自分组的 `sortOrder`；素材数组可按 Prompt 标记的首次出现顺序重排。模型、Prompt、时长及其他卡片字段保留。遇到缺映射、未核实关系或保留冲突时，当前卡 blocked，停止后续预检，不执行任何卡片写入。

`shots.status` 为 awaiting_confirmation、already_bound 或 blocked；already_bound 只表示当前选择一致。结果 fingerprint 包含原文、登记与版本证据、适用范围、映射和分镜快照；变化后应重新核对。它不是审批令牌。`apply_allowed=false` 只表示预览不授予写入权限，不禁止取得真实用户授权后使用既有绑定工具；Agent 创建的 approved 字段不是人工批准。

## 用户确认后使用现有绑定工具

按「匹配预览 → 复用建议 → 用户确认 → 模型调用原有 jubian_storyboard.select_assets」执行。集中列出项目、分集、分镜ID、素材身份、服装/身体状态、场景条件、候选ID和适用范围，让用户确认实际选项。needs_review 先补证据或明确身份并重做预览；missing 继续既有检索，不直接生成；blocked 停止受影响项。用户确认必须来自真实对话或既有审批操作，不能由 Agent 写入 approved。

得到覆盖具体计划的用户授权后，模型先沿原流程核对当前卡片、正式素材和原文、素材核对结果，再用每张 `shots[].storyboard_id` 及完整有序 `shots[].selections` 组装 `jubian_storyboard` 的 `method=select_assets` 参数。保留列表中原有场景、道具等选源，不只传新增人物；每张卡使用原流程的稳定 idempotency_key。预览 fingerprint 仅用于变化核对，不是审批凭证。同一已确认身份/版本可用于计划内多镜头，不因逐镜重复再次询问；范围、来源或版本变化后重新核对。already_bound 不重复写入。

原工具仍核查实时项目归属、有效主体身份、Prompt key 的首次出现顺序和回读结果。模型不得自行改 Prompt、模型、时长或其他素材来绕过失败。发生写入错误或未知结果时停止该项并按原 key 回读对账，不换 key 重试，不继续宣称已绑定。此预览不增加新的写入接口，也不消除原接口的并发限制。

声线仅推荐已有认可版本；先从项目圣经和声线清单核对 URL、时长、摘要及说话人，再沿原 `audio_preview → audio_apply` 流程保留完整音频列表和图片标记。不要把音频 asset_id 混入图片 selections，不把参考音频当作后台角色音色绑定或声音质量通过。
