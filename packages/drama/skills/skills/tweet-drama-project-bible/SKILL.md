---
name: tweet-drama-project-bible
description: Use when 创建短剧、确认项目参数、维护项目圣经或修改既有角色、声音、镜头包与交付要求。
---

# 项目圣经与创作启动

`project_config.json` 是唯一权威的结构化项目圣经；`project-bible.md` 由 `drama_project` 从同一数据生成，供人阅读。设定、版本与影响记录在 `project_bible`，远端身份保留顶层 `jubian_script_id`，每镜有效字上限兼容顶层 `delivery.max_effective_chars_per_shot`。不要分别编辑两份设定，也不要猜测远端 ID。

## 新项目只集中确认缺项

先调用 `drama_project action=read`，读取项目状态和当前 Settings 的预算、delivery 默认值；默认预算为 Settings 当前值，未改设置时为人民币 4000 元。沿用用户本轮已给出的参数及已确认的项目设定。查询 `jubian_catalog models` 的实际目录，准备当前账户能选的 SD2.0/SD2.5 精确模型、平台、比例和 generation 分辨率组合；没有读到的模型或通道不能写成可选项。

新剧只用一次 `ask_user_question` 集中询问仍缺少的核心参数：风格、画面比例、SD 视频模型、平台和生成分辨率。把当前目录中的精确组合与用户已有答案列在同一问题里；用户已提供的字段不再询问。成片 delivery 的 width/height/fps/min_bitrate_mbps 分别保留，展示从 Settings 读到的默认值，用户有明确变更就记录；生成分辨率不能冒充成片尺寸。episode_plan 的提纲、集数和每集目标时长可灵活确定，不要求固定集数或填满模型单条上限；用户只指定方向时先拟提纲并推进写作。

已给出的参数足够写作时可以立即继续。Wiki、模板和技能参考是创作指导，不作为写作或项目启动的前置门禁；缺少参考文本时保留用户的要求并继续独立工作。正式生成前仍用实时目录与既有 `jubian_model`/`prepare_video` 核实真实供应商能力。SD2.0 常用单条总时长为 4–15 秒，SD2.5 为 4–30 秒，均含收束；以精确模型和当前工具确认的支持范围为准，不按简称猜模型 ID，不为延长时长切换用户的已选模型。

## 写入与版本

用 `drama_project action=preview` 提交已确认的 changes 和 reason，查看 proposed、changed_fields 与 affected_stages；核对生成规格与 delivery、项目归属、预算和提纲。随后 `action=update` 使用同一 changes/reason，并原样传回 preview 的 expected_revision 与 preview_fingerprint。版本过期或预览不一致时重新 read/preview，不能绕过版本检查。初建无需远端任务、镜头包映射或已完成记录，得到真实身份后再补入。

project_bible 的 style、aspect_ratio、video（model_id/platform_id/resolution）、delivery 与 episode_plan 分别保存。initial_budget_cents 只记录初建时的 Settings 预算；current_settings_budget_cents 给出当前 Settings 值。实际计费上限由当前 Settings 与账本 authorization.json 决定，项目 changes 不接受预算覆盖。video 只记录当前目录验证的精确选择；工具不代替供应商能力检查，也不自动收费生成。不同生成分辨率和导出尺寸可以并存，不因导出较大就强制购买转高清；普通缩放须如实区分源分辨率与输出尺寸。

## 角色与声音一致性

characters 用稳定 character_id 记录角色姓名、aliases 和实际 asset_id。用当前项目主体设定核对角色，别名不当成另一个角色，姓名相似不自动绑定；画面身份、服装状态、说话人与台词分别检查。voice_profile.description 保存用户确认的年龄、性别、音色、口音和语气，每个涉及该角色的镜头包复用同一声音档案，并按原文核对谁说哪句话、dialogue/vo 与对白顺序。speaker_id 仅在当前服务实际提供且支持选择时记录；reference_audio 仅记录用户认可的路径或真实远端 ID，提交前核实精确模型/平台是否支持参考音频和字段。

固定声音提示词不能保证 SD 原生生成的跨镜音色一致。生成后实际听音核对同角色声音与说话人，发现串角色、错台词或音色漂移就标记受影响包并复核，不凭提示词宣称已解决，也不自动建立独立 TTS 通道。修改别名或其他角色字段时保留既有声音档案；新版本按受影响角色和镜头包复核。

## 在原项目里修改

package_bindings 把稳定 package_id 映射到实际 storyboard_id，可附真实 episode_id。package_id 表示视频包身份，内容或提示词修改后仍使用原 ID，不用内容哈希取代身份。先读取绑定和实时分镜，再通过 `jubian_storyboard edit_preview`/`edit_apply` 在原分镜上预览并应用已确认修改，避免复制新项目或重复建包。已有任务保持原 task ID；结果未知时继续查原任务，确认失败并查清费用后才评估重新生成。

多包修改先发现并读取当前 `edit_batch_preview` 字段说明，汇总同一轮的分镜身份与影响，再使用返回的预览应用修改；错误的 episode_id 或 duration 可在原卡上修正。删除明确属于本轮范围的坏卡时，先用 `delete_preview` 回读每个目标的任务与费用，再用 `delete_apply` 应用完整已检查范围；读取当前工具 schema 取得具体授权理由、检查清单与指纹字段，不凭名称猜调用参数。未决任务和已有付费结果需要保留身份与费用证据，删卡不代表任务取消或费用退回。

completed_tasks 只追加真实已完成任务引用；工具保留旧任务、稳定映射与 history，不把参数修改写成历史任务失效或删除。affected_stages 是复核与重建范围建议；由流程状态 writer 标记真正受影响的下游 stale，保留输入未变的成功结果，不能批量抹掉已完成记录。角色、风格或脚本改变后先复核受影响镜头及相邻衔接，生成后继续实际视觉和听音 QA。所有非 Minimal 组合继续使用现有云 ASR；版本记录不替代真实音频的说话人与字幕校验。
