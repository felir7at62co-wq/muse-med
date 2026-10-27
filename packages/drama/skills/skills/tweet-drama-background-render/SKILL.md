---
name: tweet-drama-background-render
description: Use when 剧变生成视频需要 SeedVR2 转高清，或 3D 动画、仿真人短剧需要后台合成、试听配乐、检查最终输出或批量导出。
---

# 后台成片

## 剧变视频转高清

用户要求高清，或项目已有覆盖本批视频与费用的明确高清授权时，Muse 自行完成下列流程，不逐条重复确认。仿真人剧默认使用已认可原片，转高清只作可选提示，不因画质判断自动购买。只要求新增能力不等于已指定本次付费素材；未明确的视频范围先查项目和任务。仅有 `needs_upscale=true`、720p 源片或 1080p 导出尺寸不构成高清付费授权。

使用现有 `jubian_video method=upscale`，先用 `jubian_catalog method=models, task_type=20` 读取实时高清目录；未另选时默认 SeedVR2，模型、通道、分辨率和计价行仍须来自本次真实目录，不抄历史选择器或固定单价。按项目已有选择和明确授权选用 `model_id`、`platform_id`、`resolution`，必要时用目录模型计价行的 `standard_id` 查询 `rate`。工具按当前目录报价预留预算；目录或报价不可用时报告真实缺项，不猜价格，也不改用新建分镜生成或本地放大冒充高清。默认 1080p 是目标规格／上限，不保证精确 1080×1920；保留提供方报告的实际输出尺寸，不能把目标名称当成实测尺寸。

1. 用 `jubian_video method=tasks, script_id=...` 找到本项目、本分集和本包已生成的视频任务，默认选择最新生成且成功、有输出 URL 的任务；优先按提供方生成时间倒序，缺少时间时用任务 ID 倒序。不能把别的分集或包当作“最新”来源。已有当前来源的成功高清结果直接复用；有未结束高清任务则继续查询，不重投。
2. `upscale` 输入是源任务 `task_id`，由工具回读来源身份。工具按提供方创建时间倒序读取子结果，选首个带视频 URL 且未标为未完成或失败的结果，使用它的当前 `video_url`，包括最新去字幕后的版本；不再优先退回 `base_video_url`。保留源任务、子结果和 URL 记录，无需因多个候选结果再向用户询问。用户明确指定旧版本时遵从指定；工具不能精确定位该版本则报告，不冒用默认来源。
3. 对已核对来源调用 `jubian_video({method:"upscale",task_id:<源任务ID>,task_name:"EP01-P1-SeedVR2-HD",idempotency_key:<本来源固定键>})`，遵守既有项目预算、审批与账本规则。保存 `outcome`、原 key 和 `accepted_task_id`；`accepted` 只表示受理。结果未知时保留原 key，对账或查询，不能换 key 再买一次；不以 `retry` 自动重投付费处理。
4. `accepted_task_id` 非空时，用它启动 `jubian_watch({task_id:<高清任务ID>,stage:"upscale"})` 并保存返回的 `job_id`。用 `job_output(job_id=..., wait=true)` 收取结果；后台查询期间继续独立工作，不用模型轮次忙轮询。重启后用已保存的高清任务 ID 查询 `jubian_video task/subtasks`；缺少受理 ID 时用原账本和源任务结果对账，不虚构任务 ID。
5. 从后台结果或高清任务 `subtasks.rows` 确认当前高清任务已成功、结果属于本任务、当前高清 URL 非空且有转高清记录（`last_task_type=20` 或 `hd_count>0`）。满足这些条件就直接采用当前高清 URL，并在交付或后续流程需要本地文件时用 `jubian_media method=download, media_kind=video` 下载；不退回 `base_video_url`。保留任务 ID、原 key 和结果路径供恢复；pending、failed、unknown 或缺少输出地址时继续查询或报告失败，不当作完成。
6. 高清任务完成时报告来源、目标规格、实际尺寸（未提供就注明未知）、费用口径和是否替换原片；默认不覆盖已认可版本。状态成功只证明任务完成，不证明画质改善或精确达到目标像素。无需为高清另设人脸、文字或音画质量门禁；用户要求质量检查时再追加，不因此重复付费。后续合成或交付沿用该流程已有的媒体检查，不把高清成功代替成片验收。

只做视频转高清时交付成功的高清视频及来源记录，不进入后面的整集成片流程。整集渲染规则只适用于单独请求的合成任务，不作为采用高清结果的前置条件。

## 整集成片

只消费内容审核通过的剧变结果和实际发声字幕。pending 只能做标注“未完成，非最终交付”的草稿/预览，模型安排后续查询与来源替换；最终必须 clean 或 not_required，未知或失败不可放行。对实际选用文件审核残字、损伤、分辨率及音画，不能只信成功状态或 URL。按来源映射硬切拼接；动作描述不得成为字幕。

输出最终 MP4、同名 SRT、渲染日志和可编辑草稿。渲染前用 ffprobe 校验每段真实时长；渲染后检查总时长、音视频流、黑帧、静音、**首/中/尾各抽一帧真实解码**和字幕 cue 越界。**元数据不算证据**：容器里的时长、帧率、码率在一份大量丢帧的成片上照样正常，`drama_render verify` 的 `decode_probe` 与 `render_episode.py` 的 `assert_decodes_throughout` 都会在首、中、尾各解一帧，任何一处解不出画面就判失败。编码失败时保留中间文件，只重跑失败集。

## 源画面文字与字幕叠加

准备整集渲染前，先对实际选用的视频用 `video_ocr` 免费本地抽样，读取 `scan_status`、覆盖区间与带源时间码的文字；疑似对白烧字用 `video_inspect` 抽帧查看大图，和已对齐 SRT 比对。OCR 失败、覆盖不足或噪声不等于无字，不自动转付费去字幕、转写或重生成；保留候选并列出需要复看的时间点，普通识别疑点只提示，不要求提示清零。

明确保留已有对白字时，写项目内 `subtitle_plan`：`schema_version: 1`，`decisions` 每项包含 `shot`、当前源文件 `source_sha256`、镜头内 `start_seconds/end_seconds`、实际画面 `text`、`action: "retain_embedded"`、`reason`，可选 `evidence_paths` 指向真实 OCR 或抽帧文件。区间是镜头内时间，不是整集时间；只有整条 cue 被已确认的同文区间覆盖才跳过后加字幕，局部重叠与文字不符保留提醒，不猜词级切点。计划是调用方决定，不是 OCR 检查或人工验收凭证。

沿正常 `prepare` 使用相同选源与时间线；`render` 传原 SRT 和可选 `subtitle_plan`，工具另存实际叠加的 `resolved-overlay.srt` 与 `decision-report.json`，不改原 SRT。仅需先生成草稿时，可用 `drama_render method=subtitle_overlay`，传同一 timeline、subtitle_srt、subtitle_plan；可选 `output` 指定新的导出 SRT，已有文件不覆盖。给 `jianying_draft` 的 `subtitle_srt` 必须使用结果中的 `resolved_srt`，同时传 `subtitle_overlay_report` 为对应报告路径，不能又把原来全部 SRT 叠回去。

交付说明区分后加字幕与源画面烧录字：后者不能变成可编辑字幕，也不能由 ASS 或剪映字幕样式统一字号、位置与标点。保留烧字时明确列出这些镜头和局限，不能宣称整集字幕均可编辑或样式完全统一。需要全片统一样式时先展示无字素材方案与当前候选，不自动购买去字或重生成。其余后加字幕沿项目已认可样式，实际抽帧核对单行、无标点、大小与位置，而不是只验 SRT 文本。

## 视频禁用标签

开工先用 `drama_video` list/inspect 查本项目标签；ban 至少给一个自由可读 labels（如“人物对调”），reason 可选，不要证据。SHA256 标记具体字节版本，同字节副本也禁用。标错用 unban；查询无标签或解除禁用不等于审核通过，不替代下面的 hashreview。禁止改用通用 FFmpeg、项目手写 render 或复制旧成片绕过禁用。

`scripts/render_episode.py` 在任何 FFmpeg 前检查实际 `video/NN/shot_NNN.mp4`，无需选源审核 manifest 才能识别禁用；旧缓存缺来源哈希或来源变动时重建，发布最终路径前重查源和结果。失败不覆盖已有成片。检查只覆盖该项目官方执行路径，不拦截任意外部命令；历史成片缺来源映射时不能凭查询无禁用宣称通过。

## 审核证据绑定

使用当前渲染工具前读取 schema 和 prepare 输出。prepare 的 `shots[]` 每行在有显式 package 映射且 `episode_packages/NN/package.json` 存在时记录 `package_sha256`（不是顶层字段）。审核记录的 `package_sha256`、该选源行的值与当前 package 文件字节 SHA256 必须一致；`video_sha256` 独立匹配实际选用视频，并保留内容、字幕清理及抽帧证据。审核者须对照当前 package 检查实际视频，不能机械复制新哈希来批准旧视频。package 任何字节变化（含格式化、同镜头数重编译）都保守要求重新核验证据；缺证据保持 review，不标 completed。

## 媒介与交付策略

项目用 `project_config.json` 的 `project_bible.visual_medium` 明确选择 `animation_3d` 或 `photorealistic`，原有自由文本 `style` 保留。`prepare` 将所选媒介与 `width`、`height`、`fps` 写入时间线的 `delivery`。`animation_3d` 的草稿与成片只交付正文，不添加 AI 水印、2 秒末帧、片尾音或特效，不读取或生成片尾素材；正常字幕、正文声音与 BGM 保留。`photorealistic` 的两份交付都保留右下 AI 标识与 2 秒片尾。此策略不移除源文件中已有的标记。

Python 入口从项目字段或时间线快照读取明确媒介；两者都存在时必须一致，冲突要求重新 `prepare`，无效显式值直接报错。两处都缺失时明确警告并保留旧版的 2 秒片尾和 AI 标识，不从风格文字、模型名称或横竖比推断。3D 时间线的 `body_end` 必须等于正文末尾，已有片尾标记须回到选源和 `prepare` 修正，不能直接当正文输出。

`delivery.width/height` 必须是正安全偶整数，`fps` 为 1–240 的整数。Python 同时兼容旧 `canvas: {width, height}`；它与快照尺寸不符时拒绝，缺少快照时保留原 `1440×2560 @60fps` 默认。交付尺寸不改变源媒体原生分辨率。ASS 设计画布按交付横竖比设置、短边固定 1080，字幕边距与水印位置随画布调整。

## 已确认交付样式

SD2.5（Seedance 2.5）默认使用通过内容审核的原片合成，不自动调用或等待付费转高清。needs_upscale 只是分辨率差异提示，不是原片禁用或必须购买后处理的判定；其他模型也不得仅凭该字段自动付费。仅在用户明确要求或项目已有明确高清授权时执行。用户确认的普通导出尺寸可以通过常规缩放实现，但要如实区分源分辨率、导出尺寸与高清增强，不冒称提升了原生细节。此规则优先于旧工具的强制高清提示，内容及音画 QA 不省略。

保留项目已确认的交付规格。下面是已有项目的渲染样式，不得反过来覆盖其他项目确认值；生成分辨率来自当前分镜，交付分辨率单独验收。使用 `scripts/render_episode.py` 或当前渲染工具前读取参数/schema；缺少所需能力先报告，不凭默认值宣称满足。最终输出须经 QA，渲染成功不等于验收完成。出片走 `drama_render` 的 `subtitles` → `prepare` → `render`：字幕样式、按媒介选择的水印与片尾字节都由工具校验，手写 ffmpeg 一律不继承这些校验，只有工具确实缺能力时才手工拼，拼完必须逐条复刻本节固定样式并照本节做目视复核。

将已确认的宽高和帧率写入 `project_config.json` 的 `project_bible.delivery: {width, height, fps}`，不是根级 `delivery`；prepare 读取前者，缺失时沿用旧默认。prepare 可同时提供 `bgm` 纯配乐轨和 `bgm_plan` 分段计划，在 `render_preview` 核对最终 width/height/fps、字幕文件与字族、ASS 设计字号/边距及名义输出像素、原声和 BGM 绝对路径与增益；render 返回并记录实际使用值。prepare 可选计划缺失、不可读或校验失败只作提示并保留准备成果，render 仍在编码前严格校验传入计划；空 `bgm_plan` 不证明没混入音乐，不能据此诊断漏配乐。不得把含对白的混音审查件当独立 BGM 再叠一次。SRT 不携带审查视频的字体样式，不能因用了同一 SRT 就宣称复现已认可字幕观感；普通样式差异先提示、抽帧核对，不新增批准或要求提示清零。

`drama_render` 支持在同一 `project_bible.delivery` 保存项目已认可的 `subtitle: {font_family?, font_size_px?, margin_bottom_px?}` 和 `audio: {master_gain?, bgm_gain?}`。字号与底边距是输出像素，转换为 ASS 整数设计单位；字族必须已可用。增益参数接受 0–8 的线性数值，零为静音，实际 BGM 增益受部署上限约束。prepare 将显式节保存到时间线；存在的节（包括 `{}`）整节优先，缺字段回落部署默认，没有该节才读项目。变更项目设置后重新 prepare 并核对新候选。剪映草稿读取同一显式音频节，Muse 原生 BGM 增益同样封顶 1；未配置时草稿仍为 1/1，正式成片为 1.45/0.24，要求一致时显式指定两项。旧 Python `render_episode.py` 尚不读取这些项目设置，不用它冒充当前自动配乐能力已验证。

当前 `drama_project.changes.delivery` 只接受画幅，不接受上述字幕/音频字段。先读取现有 `project_config.json`，用文件编辑工具仅增量加入这两节，保留 `schema_version`、`revision`、`history`、预算、远端绑定及其它已有字段；不得拿局部示例整份覆盖项目配置。随后重新 prepare 并核对预览。正常项目更新会保留已保存的两节，不需为此改动公共项目写入 API。

字幕外观和混音响度以同一份 `drama_render` 正式候选为审查对象，审查与交付使用相同的 delivery、字体和增益。`ffmpeg_subtitle` 加 SRT 的临时预览只证明文字与时间，不能据此宣称正式样式或混音已验收。最终交付沿用用户实际试听观看的同一候选；修改样式、delivery 或增益时另存新候选重新听看，不覆盖旧批准文件。抽帧、离线信号分析和工具技术检查不能代替实际听看；这些是流程提示，不新增硬门禁或批准步骤。

- **输出** 宽高与帧率以项目已确认值和 prepare 的 `render_preview.delivery` 为准；1440×2560 @60fps 只是旧项目缺字段时的默认，不得覆盖已认可的其他交付规格。h264，目标码率 `24M`、上限 `30M`、bufsize `48M`，现有工具检查码率下限 4.6 Mbps，交付前读取其实测结果。优先 `h264_nvenc`（`p5 -cq 19`）；探测失败自动回退 `libx264`，并把回退原因写进渲染日志。
- **正文字幕** 未配置项目覆盖时字号 40、字间距 `-2`、白字、单行、无标点、按语义切分；ASS 用 1080×1920 设计坐标（`Alignment=2`、`MarginV=140`），成片 1440×2560。**黑描边按成片像素定，字段由目标推导，不写死数字**：以 1440px 成片宽度上的 7px 为基准，目标描边随输出宽度等比缩放；ASS 里的 `Outline` 用 `目标像素 ÷ (成片高 ÷ PlayResY)` 算，标准管线（1080×1920 → 1440×2560）写入 `5`；输出尺寸变了要按宽度缩放目标描边再推导（480px 宽时约 2.3px，字段仍为 `5`）。`buildAssHeader` 与 `write_ass` 都这样算，测试钉住推导而不是钉住数字。ASS 头必须带 `ScaledBorderAndShadow: yes`——缺这个键 libass 按未缩放的栅格像素画描边，烧录的 2 倍超采样再缩回来会让它只剩一半（写死的 `Outline 3` 在成片上实测只有 1–2px，旧文档里的「约 4px」是在不超采样的直烧链上量的）。**滤镜顺序**：`fps=60,setpts=N/(60*TB)` 必须在 `ass`/`subtitles` **之后**，字幕滤镜会把时间基准锚回源帧率，放在它前面的帧率滤镜进不了成片（实测只剩 603 帧，对照组 3008 帧），而容器时长/帧率/码率三项照样正常。**不要凭字面值调粗**：早先写死的 7 在成片上量到 8–10px，与正文笔画接近，用户已判定「字幕太粗」。正文可按上文项目配置覆盖字族、字号与底边距，其余默认不变；字体部署与许可的权威说法见下面「本地依赖与入口」；剪映草稿字幕字号相互独立，见 `tweet-drama-draft-build`，改一个不得联动另一个。
- **仿真人及旧项目水印**：草稿与成片仅在右下角全程显示一次「内容由AI生成」，纯白无描边，不加右上提示。成片由 ASS 的 `Watermark` 事件携带，不再叠 `drawtext` 或第二条水印；草稿使用独立可编辑文本轨，不进入发声字幕 SRT。QA 放大右下角确认只有一条。3D 动画两条路径均不添加此标识。
- **音频** 先读剧本、实际采用视频与 `project_bible.bgm_feedback`，结合情节推进、人物关系和对白真实含义选择音乐；用词、曲名和情绪距离不能代替剧情理解。相接段落用上一实选曲的 `previous_track_id` 比较候选，核对整条序列；相邻两集尽量不重复同曲，读取本项目 N−1 及已制作 N+1 集的实际用曲，传 `adjacent_episode_track_ids` 优先选择合适替代曲；R7 提醒跨集重复，剧情确需延续时保留并记录理由。同一情绪发展可沿用一曲，确有剧情转折才合理改变音乐。按[剧情选曲与切点](references/story-bgm-selection.md)记录真实片段、标签、对白含义和过渡依据，再预览合成。Muse 自动配乐每段源曲增益封顶 −10 dB，后续正式混音和原生草稿 BGM 增益封顶 1；核对摘要绑定的合成记录及最终总增益，不把旧音乐床当成已满足新衰减要求。保留对白、已有原声和用户认可的选择；主音频旧默认 `1.45`、BGM 后续旧默认 `0.24` 及限幅算法仍适用。可以只用一首，也可以不额外添加 BGM；可按剧情留白。没有实际剧情或音乐作用的变化需要时，整集沿用一首合适的曲子；场景数、镜头数和分析段落数都不决定曲目数量；曲数、复用、边界和衔接 `policy_findings` 均是复核建议，不要求清零或新增门禁。实际试听与参数检查分别记录，不冒称听过。
- **仿真人及旧项目片尾 2 秒** 从**最后一镜 MP4 的真实尾部**抽最后一帧定格（固定 `-sseof -0.1`；**不要用 `-0.05`**——实测它在部分片子上不写文件却返回退出码 0，会静默产出一个空片尾），抽完必须用 `framemd5` 与「顺序解码的最后一帧」比对证明这一帧确实是真尾帧，对不上就按帧号 `select=eq(n\,N-1)` 重抽，仍对不上就停止出片；禁止用同号分镜 PNG 代替；叠加 `--ending-effect` 视频。**片尾固定 2 秒，但定格图、结尾音频、结尾特效三者并不等长**，各有各的长度：定格帧铺满整 2 秒；`assets/ending_effect.mp4` 实测 1.020 秒，按**自身原速**只播放一次，覆盖片尾开头那 1.020 秒，其余 0.980 秒是纯定格帧（不变速、不拉伸、不循环、不补黑场）；`assets/ending_audio.mp3` 全长 3.474 秒，只有**前 2 秒**延迟到正片结束处进入混音（增益 1、随整轨过 `alimiter=0.95`），后 1.474 秒既不进成片也不循环。片尾素材只能用随包这两份字节，`drama_render render` 与 `scripts/render_episode.py` 都按 SHA-256 校验：`assets/ending_effect.mp4`（904502 字节，`49308bce84b964c5ec6768655e84920731dcaabe14509a0d84b4c92aea590010`）、`assets/ending_audio.mp3`（83432 字节，`d1649e9c9231283a93ee3d28816c741ac3d389528654fca5ac69d75139943c0f`）；**换成别的文件直接报错，不会照常出片**。`drama_render render` 另外要求特效不长于片尾窗口：超过 2 秒同样直接报错，不做截断。
- **片尾特效完整覆盖选项**：新建仿真人交付候选时，在 `prepare` 后的共享 timeline 显式写 `ending_effect_fit: "stretch_to_window"`，除非项目已经明确选择原速短特效。正式渲染和草稿均将完整特效源按实测时长变速覆盖 2 秒；1.020 秒源的播放速度为 0.51，音频仍原速取前 2 秒。此选项不循环、不补黑场，也不把黑尾冻结冒称仍有特效；报告源时长、目标时长与速度，预览片尾后再确定效果。省略字段按上面的 `source_once` 旧规则播放一次，保留旧调用；3D 动画仍不添加任何片尾。
- **禁止**转场、额外音效、调色、滤镜、画面特效和花字；全片只有基础硬切与上述片尾特效。

**字幕可读性建议两条路径保持一致**：建议去标点、按语义切分、单行、单条不超过 14 个有效字（空格按半个字计），文字取剧本原文。缺对齐、声文不符、样式或配乐问题只返回具体路径与原因，由 Muse 判断如何处理；不要求提示清零，也不新增批准步骤。草稿路径的 `normalize_subtitle_text` 写出独立 `.normalized.srt`；超长字幕保留原文与时间，不按字数猜切点。`drama_render subtitles` 有疑点时写 `.draft.srt` 并保留原字幕；`.review.txt` 与旧 `.blocked` 只作提醒，准备和渲染可继续。保存成功不表示已完成质量验收。**字幕外观两条路径分别配置**：成片按明确的项目正文样式或部署默认（默认字族 SimHei、ASS 字号 `40`、字间距 `-2`、描边按成片像素推导）；草稿用剪映系统默认黑体（`draft_content.json` 里不写 `font` 字段）、字号 `11`（UI）、字间距 `0`（UI）、描边 `20`（UI）。改一边不得联动另一边。

## 配乐试听与反馈

给完整版配乐时，先按[剧情选曲与切点](references/story-bgm-selection.md)读取剧本、观众信息和实际时间线，为每个情绪段明确希望观众感受到什么，再用 `bgm_match.story` 查询候选。保持已认可的项目配乐决定；不要把整集压成一个平均情绪坐标，不用台词关键词代替剧情理解。返回的曲名线索与情绪标签均不是已试听证据。 生产检索必须带 `story.evidence` 的真实剧本原文和实际画面检查记录，核对当前采用视频的 SHA-256；禁止编造对白、把人物笑脸直接当喜剧、合并不同情绪段一次选曲。按工具的出处检查补齐缺项；`evidence_matched` 只证明引用和视频版本匹配，不代表剧情或听感已通过。

计划可在本集 `episodes[]` 中明确写 `music_decision: "none"`、有依据的 `decision_reason` 和 `segments: []`，正文时长仍取当前时间线；`drama_bgm` 返回 `status: "no_added_music"`，不生成或验证 WAV，空 `output` 不能传作已存在音乐。明确 `music_decision: "music"` 时可以单曲或为对白留出无音乐区间；省略决定则保留旧的连续覆盖行为。自主决定不额外配乐不等于用户已拒绝某曲，只有明确用户反馈才写入项目反馈。

先把当前项目的明确混音选择保存到项目内 JSON，并用 `mix_profile` 将同一文件传给 `drama_render audio_preview` 与正式 `render`。配置包含 `schema_version: 1`、`mode: legacy|no_bgm|ducking`、`analysis_window_ms`（10–1000），可选 `original_gain` 和 `music_gain`（0–8）；旧调用不传配置时保持旧默认。`no_bgm` 不读取 `bgm` 或 `bgm_plan`，只去掉后加配乐，不会分离或删除原片里已有的音乐。`ducking` 必须明确提供 threshold_db、ratio、attack_ms、release_ms、knee；它由原声能量驱动，不是语义 VAD 或纯对白分离，不能保证所有音效都不触发压低。

例如项目明确选择沿用旧增益时，`editing/audio-mix.json` 可为 `{"schema_version":1,"mode":"legacy","analysis_window_ms":100,"original_gain":1.45,"music_gain":0.24}`；这些数值不是所有项目的新推荐。实际试听调用形如 `drama_render({method:"audio_preview",project:".",episode:1,timeline:"editing/01-timeline.json",audio:"audio/01.wav",bgm:"audio/bgm/01.wav",mix_profile:"editing/audio-mix.json",start_seconds:0,duration_seconds:8,intended_use:"unknown"})`，将集号、文件与时间窗换成当前真实素材，时长大于 0、最多 60 秒且不越正文末尾。可附 `bgm_plan` 交接许可，附 `bgm_generation` 回读该条 BGM 实际 generation.json 的源窗口响度与增益；收据 SHA-256 必须匹配完整配乐文件，缺收据就如实标为未提供，不能推算冒充。

选曲或混音信心低时，先生成同一对白片段的实际可播放 A/B 试听，A 为拟交付混音，B 为无后加配乐的原声；另留纯配乐 stem 便于定位遮盖与对白叠播。只用现有本地素材，不为试听新购视频、图片或转写。给出短片路径、时间窗、差异和未确认点，集中一次请求反馈，不逐曲反复打断；普通曲数、复用和风格差异不新增批准步骤。未实际播放不能写成“试听通过”，RMS/peak 只能说明测量结果，不能代替听感。用户明确反馈后，按项目圣经技能以新 ID 追加 `bgm_feedback`；Agent 自己的偏好不落成用户反馈。

`audio_preview` 返回新目录中的 `selected_mix`、`without_added_music` 和 `analysis` 路径，有后加配乐时另返回 `music_stem` 路径，不覆盖旧试听；`no_bgm` 的 `music_stem` 为空，不生成假配乐文件。分析里的固定短窗 RMS/peak 与 R128 Momentary（400ms）、Short-term（3s）分别解读，不把它们统称纯对白响度或用户已认可。正式 `render` 复用同一 `mix_profile`，有配乐时把返回的独立纯配乐 stem 交给草稿；不能把含对白的审查混音再次作为 BGM 轨。

BGM 授权信息交接：`match/download` 的 `intended_use` 与计划中本集的 `intended_use` 保持一致，未知用途写 `unknown`，不能默认非商业。选定后把下载结果的 `license_info`、`track_id` 原样写入每段；把 `download.sha256` 写入 `source_sha256`，本地候选使用返回的同名摘要，以便合成前核对源曲字节。缺失信息保留 `unknown`，不能补造许可证或写成已审批；`declared` 只表示来源声明完整。检查候选/下载的 `license_warnings` 及合成/渲染的 `license_records`，交付保留来源、署名和范围。曲目许可与分析模型许可分别核实，不能将二者互相替代：m-a-p/MERT-v1-95M 标注仅限非商业用途，商业使用须另核该模型及分析链路许可；这不自动说明每首曲目都禁止商用。风险提示不阻断、可下载或用户认可效果，都不等于获得使用权。

## 本地依赖与入口

本包包含维护源码和片尾这两份素材（本技能目录下的 `assets/ending_effect.mp4`、`assets/ending_audio.mp3`），不包含 BGM、字体或 FFmpeg 二进制。安装 FFmpeg/ffprobe（需字幕滤镜和所选编码器）；路径读取 `DSH_FFMPEG_PATH` / `DSH_FFPROBE_PATH`，兼容 `FFMPEG_PATH` / `FFPROBE_PATH`，否则使用 PATH。**字体只有这一处权威说法**：随包字体只存在于 muse-med Windows 产品——它捆绑 OFL 授权的 Noto Sans CJK SC，未配置项目正文覆盖时 ASS 正文 40、水印 44 及其余默认不变，Python 通过 `MUSE_FONTS_DIR` 和 `MUSE_FONT_FAMILY` 使用包内字体，正式 `drama_render` 由产品配置传入同一目录和字族；`background-render` 与 `draft-build` 的其余段落都不再另称 SimHei。非产品部署没有随包字体，字族回落为系统发现的 SimHei（正文）与 Microsoft YaHei（水印），即 `drama_render` 的默认值，或用 `DSH_FONTS_DIR` 指定已授权目录，需自行确认这两个字体可用且已获授权；选择 Noto Sans CJK SC 的理由是它可以随包再分发（OFL），SimHei 不行。脚本仅依赖 Python 标准库和相邻 `tweet-drama-core/scripts/video_bans.py`，建议 Python 3.11+，运行时用 `python -B`。

单集入口 `scripts/render_episode.py` 的旧调用仍需显式提供 `--bgm`（本集实际选择并试听的配乐音轨，不限定曲数）；无后加配乐或项目级混音使用当前 `drama_render` schema 支持的显式方案，不以静音文件假装已经选曲。仿真人及旧项目还必须提供 `--ending-audio` 和 `--ending-effect`，指向本技能 `assets/` 下的两份素材，缺失或字节不符都明确失败。3D 动画无需片尾参数，即使传入也不读取。批量入口 `scripts/render_batch.py` 使用 `--bgm-dir` 中逐集的 `NN.mp3`，每集独立执行同一媒介策略。选曲情绪与使用授权由项目分段记录和试听核验，脚本不从已混音文件推断曲目。生成规格服从当前模型目录与分镜，脚本按时间线 `delivery` 快照输出并校验尺寸和帧率，缺少快照时保留上面的旧版默认。

`drama_render` 和单集、批量脚本的所有项目输入/输出相对路径均以 `project` 为基准，绝对路径保持不变。跨工具传递绝对项目根目录；相对 `project` 只在入口按调用进程的工作目录解析一次。字幕、时间线、清单、BGM、片尾、显式输出及单集 `--freeze-image` 都遵循此规则；批量 `--bgm-dir` 同样以项目为基准。项目外的随包片尾素材使用本技能实际安装位置的绝对路径，不把 `assets/` 误当 Host 工作目录。字体和 FFmpeg 部署配置不属于项目路径，不改变工作目录来适配它们。

FFmpeg 的许可取决于安装构建的组件；音乐和字体各自需要使用授权。随包的两份片尾素材按操作者授权收录，只担保本机使用，不构成公开再分发授权。维护源码未附独立上游许可证；不把本机可访问等同于可公开分发。

## 交付两份

每集默认留两份交付物：`exports/<episode>.mp4` 直出成片，以及剪映专业版草稿目录。剪映草稿目录由用户明确指定，或从已配置的 `DSH_JIANYING_DRAFTS_DIR` 读取，同时在项目内保留归档副本。渲染前用 ffprobe 逐段核对真实时长，成片与草稿使用同一套镜头顺序和字幕时间。
