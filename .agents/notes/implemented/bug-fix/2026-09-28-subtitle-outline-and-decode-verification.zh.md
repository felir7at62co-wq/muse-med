# Agent Note: 烧录字幕描边与解码校验

Status: implemented

[English](2026-09-28-subtitle-outline-and-decode-verification.md) | 中文

## Problem

[2026-09-28 的交付复核](2026-09-28-short-drama-delivery-defects.zh.md)把「字幕太粗」改成把烧录 ASS 字段从 `Outline 7` 调成 `Outline 3`，并在成片上量到 `4px`。这个取值和这次测量漏掉的是同一件事：`Outline` 的单位是脚本画布，libass 只有在 `ScaledBorderAndShadow` 打开时才把它缩放到实际栅格的那一帧。本包的 ASS 头没有这个键，于是字段被当成未缩放的栅格像素画出来；而这个头是经过 2 倍超采样烧录的（`scale=2880:5120`、`ass`、`scale=1440:2560`），缩小那一步又把本该放大的量减半。按本包自己的烧录链实测，当时发版的 `Outline 3` 画出的是 1–2px，而不是那条笔记记下的 4px——4px 是在成片尺寸上直烧量到的，同一个字段在那里宽三像素。

同一次复核的那次运行自己写了 FFmpeg 链，把 `fps=60` 放在 `subtitles` 之前。字幕滤镜会把时间基准锚回源帧率，帧率变换因此没有进入编码：成片容器报 116.7 秒、60fps、正常码率，而对照组的 3008 帧里只有 603 帧解得出，`-ss` 到 30 秒一帧都取不到。`drama_render verify` 当时不解码画面，这种文件能通过交付已有的每一项检查。

两个量纲不一致就挨着这件事。剪映草稿的 `styles[0].strokes[0].width` 是 `0.04`，而样式规范写 `20`，两处都没写量纲。烧录字幕的字体在样式条目里写 `SimHei`，在依赖一节里写随包的 `Noto Sans CJK SC`。

## Decision

**描边以成片像素为准，字段一律推导，不写字面值。** `SUBTITLE_OUTLINE_TARGET_PX` 是 7，[`assOutline(targetPx, playResY, outputHeight)`](../../../../packages/drama/tool-episode-render/src/delivery.ts) 计算 `目标像素 x playResY / outputHeight`：成片上的描边宽度是 `Outline x 成片高 / PlayResY`，而烧录的 2 倍超采样正好抵消，因为缩小那一步把翻倍的栅格减半。标准几何（画布 1080x1920、成片 1440x2560）推导出的字段是 5，实测最细行程 5px、中位行程 7px，超采样链与直烧链结果一致。`buildAssHeader` 与技能里的 `write_ass` 调同一条规则，两侧测试钉住推导过程——成片高度一变就重新推导（3840 高得 4），而不是继承一个数字。

**ASS 头现在带 `ScaledBorderAndShadow: yes`。** 没有这个键，上面的推导就描述不了实际渲染，所以它是样式约定的一部分，不是可省的一行。

**烧录链以帧率滤镜结尾。** `subtitleBurnFilter` 与技能里的 `subtitle_filter` 都以 `fps=60,setpts=N/(60*TB)` 结尾，位置在 `ass` 之后。无论拼接来的正片带着什么时间基准，进入编码器的画面都是固定帧率且从 0 开始。

**`verify` 解码画面，而不是读元数据。** `decode_probe` 检查分别 seek 到 0.05 秒、中点、以及结尾前 0.1 秒，各用 `showinfo` 解一帧，任何一处解不出帧就判失败；解码器自己的退出码不算结论，因为 seek 到被截断文件真实结尾之后仍会以 0 退出且什么都不解。技能的 `render_episode.py` 用 `assert_decodes_throughout` 跑同样三处探测，通过后其输出才替换上一版成片。

**草稿字幕的值是剪映 UI 单位，换算只有一套说法。** `jianying_draft.py` 用 `SUBTITLE_*` 常量写出这些值，并按 `pyJianYingDraft` 写草稿时用的映射标注：字号原样（`11` → `11.0`）、字间距 x 0.05（`0` → `0.0`）、描边 ÷ 100 x 0.2（`20` → `0.04`）、行间距恒为 `0.02 + 值 x 0.05`，所以文件里的 `0.02` 是基线而不是设置。样式不写 `font` 字段，就是「用剪映自己的默认字体」：草稿文件里没有字体名可核对。草稿的字号 11 与成片的字号 68 是两个独立约定，任何一侧的数字变动都会让另一侧的测试失败。

**字体只有一处权威说法。** 它就是字族的出处，而字族属于部署配置：muse-med Windows 产品随包 OFL 授权的 `Noto Sans CJK SC`（正文 68、水印 44），经 `MUSE_FONTS_DIR`/`MUSE_FONT_FAMILY` 与正式 `drama_render` 的产品配置传入，理由是它可以再分发；其他部署一律回落为系统发现的 `SimHei` 与 `Microsoft YaHei`（也就是插件默认值），本包不分发任何字体文件。

## Alternatives considered

**保留 `Outline 3`，把意图写成设计坐标下的宽度。** 否决：那会让看得见的描边宽度取决于烧录分辨率——同一个字段在本包的超采样链上比直烧窄三像素——而推导存在的意义正是消除这种漂移。

**只写字面值，不写 `ScaledBorderAndShadow`。** 否决：libass 会把字段当成栅格像素，取值就得按每种烧录分辨率重新调，2 倍超采样也会变成样式里没写出来的一部分。

**继续用画布单位，把操作者的「7px」改写成 `Outline 7`。** 否决：`7` 正是操作者判定太粗的取值（成片上 8–10px），而这次复核讨论的量就是成片上的宽度。

**用 `ffprobe -count_frames` 统计帧数，代替抽帧探测。** 不作为主检查否决：那是把两分钟的母版再整解一遍，而这次故障的表现就是某个位置一帧都取不到，三次 seek 直接给出答案。

**只在文档里规定帧率滤镜的顺序。** 否决：链是本包拼的，顺序就该在产生它的地方强制，并且可以对着本包写出的字符串测试。

## Consequences

解码校验让每次 `verify` 多花三次 seek 和最多两帧解码，并且会让一个还能部分播放的文件判失败——这正是想要的判定，因为尾部解不出来的成片不能交付。技能的兜底渲染器在发布前付同样的代价。

推导成立的前提是脚本带 `ScaledBorderAndShadow` 且缩放是等比的：如果在烧录与编码之间对画面做非等比缩放，推导就不成立；测试断言的是链本身的形状，而不是运行时去量渲染出来的描边。

草稿的换算按 `pyJianYingDraft` 自己的映射记录，而不是由它强制：库升级若改了映射，文件里的数字会变而 UI 常量不变，所以 Python 测试在该库可用的环境下真的构造一个 `TextSegment`，钉住导出的 `0.04`/`0.0`/`11.0`。

## Verification

`pnpm vitest run packages/drama/tool-episode-render` 通过 269 项测试，包括 `assOutline` 的重新推导、ASS 头的 `ScaledBorderAndShadow: yes` 与推导出的字段、烧录链结尾的 `fps=60,setpts=N/(60*TB)`、右下角唯一且没有右上角提示的 AI 标记，以及 `decode_probe` 对可解码文件判绿、对尾部取不到帧的文件判红。

`packages/drama/skills/tests` 下的 `python -B -m unittest` 三个套件全部通过（共 162 项测试），包括新增的 `tests/render/test_subtitle_contracts.py`：`render_episode.py` 里同一条推导与同样的链顺序、三处解码探测在尾部解不出时抛错（另用真实 FFmpeg 量过：一份 30 秒 / 1800 帧元数据在截断后仍完好，头部解出 2 帧，15.0 秒与 29.9 秒解出 0 帧）、唯一一条右下角标记、草稿 UI 取值与库导出的 `0.04`，以及草稿模块既不含水印文字、除 `字幕轨道` 外不建任何轨道。

描边是量出来的，不是断言出来的：`color=c=gray:s=1440x2560` 经 `buildAssHeader` 与 `subtitleBurnFilter` 烧录后，扫描紧邻白色字形的黑色行程，在推导字段 5 下得到最细行程 5px、中位行程 7px；同一脚本去掉 `ScaledBorderAndShadow` 得到 2px，改动前的 `Outline 3` 配该头得到 1–2px。

重新生成工具目录并重录本次涉及的配对记录后，`pnpm run verify-tool-catalog` 与 `pnpm run verify-translation-pairing` 通过；配对检查仍只报 `docs/superpowers/` 下那三份早于本次改动、没有对照文档的文件。
