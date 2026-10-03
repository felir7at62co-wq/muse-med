# Agent Note: 2026-09-28 交付评审提出的四个短剧缺陷

Status: implemented

[English](2026-09-28-short-drama-delivery-defects.md) | 中文

## Problem

2026-09-28 的运营评审对《山海自有相逢处》第25集提出四个缺陷——与剧本矛盾的孕肚、对什么都惊讶的人物、看起来太粗的字幕、重复的水印。会话日志（`dsh-session-session-8771b5c0-a535-4240-8af1-6d61427b1e44`）显示四个都出自本流水线，而不是提供方生成的画面。

**角色状态。** 本集原文写的是 医生：孕八周。这次运行把沈知意绑到了 `沈知意（孕期职场装）`（资产 81685 / material 79293），而那张设定板是孕晚期身形，于是分镜3（1032840，25-2 地下停车场）与分镜4（1033048，25-3 车内）生成了足月孕肚，分镜2（1032828，25-1 诊室）反而是对的。会话在日志 L2507 已自我诊断：「是资产挂了错的那一版…那张设定板本身就是孕晚期身形」。整条链路没有任何一步拿资产身形与剧本孕周比对，而这次运行临时写出的分镜规格（`_inbox/boss-spec.md`）只管台词、运镜、构图与角色名，对身体状态只字未提——它唯一与年龄有关的规则是「第47集起…年龄状态必须随之变化」。

**表情。** 编译用的分镜脚本给沈知意在平淡的问句「干什么？」上写了 `【眉毛抬高，嘴唇张开，眉间收了一下】`，在「谁说怀孕就不能开车？」上写了 `【眉毛抬高，唇角平，肩线放松】`；成片车内那一段就是一张没有触发事件的、张着嘴的惊讶脸。本集唯一有剧本依据的惊讶是林晚的「捂住嘴，眼睛瞪圆」。原有规则禁止抽象情绪词、要求写可观察体征——正因为要求写可观察体征，凭空写出的「眉毛抬高」才会被渲染成真实表情。

**字幕描边。** 每条交付路径都把 ASS 描边设成 1080x1920 设计坐标下的 7（`delivery.ts`、技能里的 `render_episode.py`，以及这次运行实际烧录的手写 ASS）。烧到 1440x2560 成片上，7 实测为 8–10px 的黑带，与 68 号汉字的笔画一样宽。这次改用的取值在另一个方向上错了：[描边与解码校验那份 Note](2026-09-28-subtitle-outline-and-decode-verification.zh.md) 拥有修正后的约定，以及「随包表头只渲染出 1–2px」的那次实测。

**水印。** 成片右下角有两条「内容由AI生成」。这次运行绕过了 `drama_render render`，自己拼 ffmpeg：它的 ASS 里带一条 `Mark` 事件（日志 L2131），滤镜链上又加了一条 `drawtext`（日志 L2143），会话在 L2522–L2530 确认「我写了两遍」。

## Decision

描边当时在 1080x1920 设计坐标下取 3，两个渲染器一起改：[`buildAssHeader`](../../../../packages/drama/tool-episode-render/src/delivery.ts) 与 [`tweet-drama-background-render/scripts/render_episode.py`](../../../../packages/drama/skills/skills/tweet-drama-background-render/scripts/render_episode.py) 里的 `write_ass`。[描边与解码校验那份 Note](2026-09-28-subtitle-outline-and-decode-verification.zh.md) 反转了这个取值：同两个渲染器改为按成片 7px 推导字段并写出 `ScaledBorderAndShadow: yes`，描边约定由那份 Note 拥有。工具描述仍然说明这条标记的来源：渲染器写出的 ASS 只携带它一次，再叠 `drawtext` 或 `overlay` 就会重复；`subtitles.spec.ts` 钉住构建出的文档里这条标记恰好出现一次。

水印、字幕样式与片尾字节都由 `drama_render` 执行，因此技能现在要求出片走 `subtitles` → `prepare` → `render`，并点名手写 ffmpeg 是不继承这些校验的那条路；只有工具确实缺能力时才允许手工出片，且同样适用固定样式与右下角目视复核。

[tweet-drama-shot-asset-match](../../../../packages/drama/skills/skills/tweet-drama-shot-asset-match/SKILL.md) 在绑定环节拥有角色状态：每个角色每集先写一张状态卡（含孕周或年龄段的体型、服装版本、发型、时段），取自剧本或已确认大纲，绑定前与该资产设定板逐条对齐。设定板与剧本状态不一致的资产就是错的版本，哪怕名字对得上。状态卡现在落在两处机器可读的地方——镜头的 `身体状态` 字段，以及资产的 `state_or_costume` 加 `episodes` 登记——不一致时 `drama_shot` 直接拒绝绑定；该强制由[状态门禁那份 Note](2026-09-28-character-state-gate-at-binding.zh.md) 拥有。

[shot-script-creator-9-16](../../../../packages/drama/skills/skills/shot-script-creator-9-16/SKILL.md) 拥有表情：反应类表情（惊讶、震惊、瞪眼、挑眉、后退、捂嘴）必须在同一镜或上一镜写明触发事件，且触发事件取自本集台词或 ▲ 动作行。原文只是平常问句的镜头不得写挑眉或瞪眼，同一个表情词也不得跨无关镜头复用。

## Alternatives considered

**把描边做成插件 `Config` 字段。** 否决：描边与同一个表头固定的画面尺寸、码率一样，属于交付规格；做成随部署变化的字段，就会允许某个项目悄悄交付另一种观感。

**把状态卡做成机器可校验的字段。** 本 Note 当时留作待办，后在[状态门禁那份 Note](2026-09-28-character-state-gate-at-binding.zh.md) 里实现：本集体型进入镜头自己的 `主体状态追踪` 块（`身体状态`），登记侧用清单已有的 `state_or_costume` 与 `episodes`，由 `drama_shot` 拒绝不符的绑定。2026-09-28 那次运行本就有提示词层检查，仍然挂错了版本——提示词层不够。

**直接禁用惊讶类词汇。** 该词汇在剧本确有惊讶时是合法的，全面禁用会破坏林晚「捂嘴瞪圆」那一下。改为要求触发事件，既保住合法用法，也挡住凭空添加。

## Consequences

四项修复里有两项是提示词与默认值，不是强制。资产身份、所绑版本登记的状态、以及该登记的集数覆盖现在由 `drama_shot` 强制（见[状态门禁](2026-09-28-character-state-gate-at-binding.zh.md)）；资产设定板图片本身、以及没人声明状态的角色，仍依赖技能与工具本就要求的评审。

重新生成 `docs/tool-catalog.md` 同时带正了两行在 HEAD 就已过期的文字：`drama_shot` 的占位值规则与 workflow `agent()` 的上报契约改了工具描述却没有重新生成目录，因此本次改动之前 `verify-tool-catalog` 就是失败的。

## Verification

`pnpm vitest run packages/drama/tool-episode-render` 通过，其中包含新增的「标记恰好一次」断言。

`pnpm run verify-tool-catalog` 与 `pnpm run verify-doc-budgets` 通过。`pnpm run verify-translation-pairing` 报出 `docs/superpowers/` 下三份未成对的文档，本次改动涉及的配对一个都没有；`pnpm run verify-md-links` 报出其它笔记里十处失效目标，本笔记一处都没有。

描边取值是实测而不是断言：`ffmpeg -f lavfi -i color=white:s=1440x2560 -vf ass=<probe>.ass`，SimHei 68、PlayRes 1080x1920，然后量取整幅画面上的黑带宽度——原先的 Outline 7 配 `ScaledBorderAndShadow: yes` 为 10px。那次探测是把脚本直烧到成片尺寸，且它自己的表头省略了该键：这既解释了随包表头为何量到 8px，也解释了它支持的替换值在渲染器的超采样链上只有 1–2px；[描边与解码校验那份 Note](2026-09-28-subtitle-outline-and-decode-verification.zh.md) 记录了修正后的实测。

`python -B -m unittest discover` 覆盖 `packages/drama/skills/tests`，含 Python 渲染器各自的字族断言。
