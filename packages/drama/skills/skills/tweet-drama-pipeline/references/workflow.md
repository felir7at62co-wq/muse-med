# 仿真人流水线依赖映射

| stage | skill / 工具 | 核心检查 |
|---|---|---|
| project | tweet-drama-project-bible / drama_project | 一次确认缺项、实时 SD 模型组合、分离生成与交付规格；版本与影响预览 |
| source / episodes | tweet-drama-script-convert / tweet-drama-script-split | 原件归档、分集边界、缺漏字 |
| style / assets | tweet-drama-asset-extract | 先读实时主体设定，仅缺失资产需提示词和生成 |
| asset_candidates | jubian_video image_generate_batch / image_generate | 整批提示词检查、逐项成功 ID 与审核证据；本地正式主体可按门禁跳过 |
| official_assets | tweet-drama-asset-vision-check / jubian_asset | 非本地 material_id + 确认出演回查；本地主体独立门禁 |
| shots_and_matches | shot-script-creator-9-16 / tweet-drama-shot-asset-match | 原文、说话人、发声方式、正式资产身份；节奏建议仅警告 |
| video_tasks | tweet-drama-early-shot-script / jubian_storyboard | 全部视频包先编译、预览并统一检查，含收束与整批费用；通过后同轮并行提交独立分镜 |
| reviewed_videos | jubian_video subtasks / jubian_storyboard erase_subtitle | 实际选用视频内容 QA；最终仅 clean/not_required |
| draft | tweet-drama-draft-build | pending 仅非最终预览；实际发声字幕，不伪造完成 |
| export | tweet-drama-background-render | 最终 MP4/SRT/草稿/来源映射、选曲计划与试听、实际输出 QA |

依赖就绪即可推进独立集或镜头，不要求整剧串行。模型自主安排异步任务后续查询，期间做独立工作。pending/unknown 查原 task ID，不盲目付费重投；确认失败后按根因、已花费用及剩余授权评估恢复。

主体视频路径保持有序：本轮全部分镜先完成 select_assets（免费 isGenerate=0）与 prepare_video（只读 preview）；汇总 preview 路径和 fingerprint，与本次授权分镜 ID 逐一对应并排除遗漏、重复，再统一核对项目、原文、包边界、资产身份/顺序、规格、已有任务与整批预计费用。任一包未通过则修正并重查本轮全部视频包，禁止提前收费。全批通过后调用一次 jubian_storyboard submit_video_batch，把独立分镜的 preview_path 与各自 idempotency_key 放入 video_previews；工具核查本次提交清单内全部 preview、预约整批预算，再有界并行执行每项一次 isGenerate=1 PUT，按输入顺序逐项返回对账结果。授权范围内无需逐笔即时批准。禁止 direct POST 视频任务；提交后回读子项身份，丢失即暂停诊断。

非本地候选需 material_id、confirm_casting 成功和父资产回查一致；isLocal=1 正式主体须当前项目、isUsed=1、hsAssetStatus=Active、URL/hsAssetId 与父资产及 picker 一致。跳过生成链经唯一 writer 的合法阶段写 skipped、reason=skipped_with_official_local_evidence 和对应证据。
