# Agent Note: 草稿侧的时间线、增益与字幕文本契约

Status: implemented

[English](2026-09-27-draft-timeline-and-subtitle-contracts.md) | 中文

## Problem

《山海自有相逢处》第25集的剪映草稿只有 15 秒画面，而音频 50.208 秒：三个视频段各 `source={start:0,duration:5000000}`，`target` 落在 0/5 秒/10 秒。[`jianying_draft.py`](../../../../packages/drama/skills/skills/tweet-drama-draft-build/scripts/jianying_draft.py) 读的是 `payload["clips"]`，而上游 `25.timeline.json` 写的是 `shots` 加 `start`/`end`。`clips` 取到空，每段退回文件自己的 `CLIP_DURATION = 5 秒`，没有任何一步拿结果和音频对比——同一个静默默认也把「媒体素材与这一集对不上」藏了起来。另有两处缺陷同行：主音频写成 `audio_segment.volume = 15`，那是归一化之前的工作流遗留，而输入已做 loudnorm（实测峰值 −0.6 dBFS），15 倍必然削波；草稿直接导入 `editing/25.srt`，于是字幕保留了成片规则明令去掉的标点与超长行，草稿里也没有字体字段。

## Decision

**时间线只有一种形状。** `{"clips": [{"shot": 1, "start_us": 0, "duration_us": 10080000}]}` 是唯一被接受的文档——就是 `drama_render prepare` 写进 `editing/<集>-timeline.json` 的那份，它的 `body_end`（第25集为 50.208）等于各段之和，也等于实测音频时长。`load_edit_timeline` 要求 `clips` 为非空列表，每项含整数 `shot`/`start_us`/`duration_us`，且 `shot > 0`、`start_us >= 0`、`duration_us > 0`、镜头号不重复；带 `shots` 加 `start`/`end` 的文件按名字点出问题后拒绝，不再当空处理。`assert_timeline_matches_audio` 要求各段之和与实测音频相差不超过 `TIMELINE_TOLERANCE_US`（0.2 秒，几帧容器的量级）。`DEFAULT_SHOT_DURATION_US`（5 秒）只在**完全没有**时间线文件的集上保留：那条路径会 warn，并且过不了下面的交付校验。

**单位增益。** `VOICE_VOLUME = 1.0` 取代写死的 `15`。01_audio 的主音轨本身已归一化，草稿不再加任何增益；`BGM_VOLUME` 保持 `pyJianYingDraft` 自己的 `1.0`。

**一套文本规则，两个渲染端。** `normalize_subtitle_text` 去标点、按语义组切分、把每行压到不超过 14 个有效字（空格按半个字计），并按字重切分该 cue 的时间；`normalize_srt` 写出 `<草稿目录>/<集>.normalized.srt`，草稿导入的就是它。字体、字号、字间距、描边仍是两条路径各自的契约，两份技能文档现在写着同一段话说明这一点。

**交付校验。** `verify_draft_delivery` 读 `ScriptFile.dumps()` 即将写出的那份 JSON，只有满足下列全部条件才放行：视频总时长等于音频总时长、段数等于镜头数、没有任何一段用默认时长、字幕条数等于规范化后的字幕行数、每条字幕都带草稿样式契约的值且文本已规范化。拒绝交付时会删掉本次刚建的草稿目录，半成品不会挡住重跑。没有时间线的集同样被这道校验拒绝。

## Alternatives considered

**两种形状都接受（先读 `clips`，否则读 `shots`）。** 否决：两个产出者会继续各写各的，读的人只能猜手上这份是哪一种。生成器现在明说自己要什么，而产出者那边的官方文档本来就写的是 `clips`。

**按输入实测响度推导草稿增益。** 否决：输入按设计已经归一化，推导结果就是单位增益；草稿侧再测一次等于为了拿到 `1.0` 引入音频分析依赖，而且只可能加上增益。

**就地规范化 `editing/<集>.srt`。** 否决：那是成片路径的输入，归写它的工具所有。草稿写自己那份规范化副本，共用规则则把两条路径的文本契约写成一条。

**直接删掉 5 秒默认值。** 否决：没有时间线的集仍然需要能预览的草稿。现在它是一个显式 warn、不可交付的状态，而不是静默状态。

**交付校验回读写出的 `draft_content.json`。** 否决，属重复：被校验的对象就是 `save()` 即将写出的同一份 JSON（两边都走 `dumps()`），回读只是把同样的字节在落盘前再解析一遍。

## Consequences

运行期的草稿不再隐含对镜头时长的假设：时间线缺失、字段名不符或与音频对不上的集现在会响亮失败且不留草稿，这正是要点——旧行为交付的是一份看起来成功的 15 秒草稿。

交付校验是硬性前置条件，所以将来若真想要「按默认时长铺」这种变体，它必须变成显式输入，而不是回退。

容器取整的差异照旧可见：第25集第 1 镜 `VideoMaterial.duration` 报 10.042 秒，ffprobe 实测 10.08 秒，于是每镜按容器截断，整集画面比音频短 82 毫秒——在 `TIMELINE_TOLERANCE_US` 之内，现在由校验比对的那两个数字如实报出。

## Verification

`packages/drama/skills` 下的 `npm test` 通过（91 + 24 + 55 个测试，exit 0），其中包含新增的 `tests/render/test_draft_delivery_contract.py`（8 个测试，exit 0）：`shots`/`start`/`end` 的时间线被拒绝且不留草稿目录、每镜从正确的时间线取自己的时长、音频段写出 `volume: 1.0`、带标点的输入变成单行无标点且条数与草稿一致的字幕、校验拒绝错误的视频总时长、缺失的时间线与缺失的样式字段。

用第25集的真实素材（audio/25.wav、media/25/p{1,2,3}.mp4、editing/25.srt、editing/25-timeline.json）跑生成器，写出的是 10.042/20.042/20.042 秒的视频段对上 50.208 秒、`volume 1.0` 的音频轨，23 条规范化字幕，并通过自身校验。同一集把时间线字段名换成 `shots`/`start`/`end` 再跑，修复前的生成器写出的是三个 5.000 秒段（`target` 0/5/10 秒，共 15.000 秒画面）与 `volume 15` 的音频段，并直接导入 21 条原始 SRT；修复后的生成器按名字拒绝这份文件，且不留草稿。

[2026-09-28 交付评审](2026-09-28-short-drama-delivery-defects.zh.md)负责同一次评审里的描边、水印与角色状态决定；本记录负责草稿侧的输入。
