"""前贴提示词生成 — 新三段式流水线。

链路(B线核心):
  1) grok 按框架写【一段纯故事文本】(剧情质量, 靠情节推进而非镜头快切)
  2) 把故事分别喂给两个 Gemini 框架:
     - seedance_pe.optimize_to_prompt  → 最终 Seedance 2.0 视频提示词
     - build_narration_prompt + Gemini → 最终口播文案
  => 返回 5 条 {framework_id, framework_name, prompt(视频提示词), narration(口播), story(原故事)}

分工: grok 专注讲好故事, Gemini 专注把故事翻成规范提示词/口播稿, 剧情质量更高。
并发: 5 套框架并发; 每套内部 story→(视频提示词 ‖ 口播) 也并发。
"""
from __future__ import annotations

import asyncio
import logging

from ..models.llm import get_llm
from ..seedance_pe import service as seedance_pe
from .frameworks import FRAMEWORKS, build_meta_prompt, build_narration_prompt

logger = logging.getLogger("frontcut.prompts")


def _extract_content(resp) -> str:
    """只取消息的 content 文本; 空/异常一律返回空串。

    ⚠️关键: 绝不能 fallback 到 str(resp)——那会把整个 AIMessage 对象
    (content='' additional_kwargs=... 这种)转成字符串当成有效结果, 污染下游。
    """
    c = getattr(resp, "content", None)
    if isinstance(c, list):  # 有些 provider 返回分段 content
        c = "".join(str(x.get("text", "") if isinstance(x, dict) else x) for x in c)
    return (c or "").strip() if isinstance(c, str) or c is None else str(c).strip()


async def _invoke_story(provider: str, meta: str, *, fid: str, rounds: int) -> str:
    """用指定 provider 生成故事, rounds 轮退避重试; 拿到非空 content 即返回, 否则返回空串。"""
    llm = get_llm("generate", temperature=0.9, provider=provider)
    for attempt in range(rounds):
        try:
            resp = await llm.ainvoke(meta)
            story = _extract_content(resp)
            if story:
                return story
            logger.warning("frontcut %s [%s] 第%d次返回空 content, 重试", fid, provider, attempt + 1)
        except Exception as e:  # noqa: BLE001
            wait = min(2 ** attempt * 2, 20)
            logger.warning("frontcut %s [%s] 第%d次失败(退避%ds重试): %s", fid, provider, attempt + 1, wait, e)
            await asyncio.sleep(wait)
            continue
        await asyncio.sleep(2)
    return ""


async def _grok_story(meta: str, *, fid: str) -> str:
    """生成一段纯故事文本: 先 grok(5轮), 反复失败/空输出则 Gemini 兜底(3轮)。失败抛异常。"""
    story = await _invoke_story("grok", meta, fid=fid, rounds=5)
    if story:
        return story
    logger.warning("frontcut %s grok 反复失败/空输出, 改用 Gemini 兜底写故事", fid)
    story = await _invoke_story("gemini", meta, fid=fid, rounds=3)
    if story:
        return story
    raise RuntimeError("故事生成失败: grok 与 Gemini 兜底均未产出有效内容")


def _smart_truncate(text: str, max_chars: int) -> str:
    """在 max_chars 内以最后一个句末标点截断, 避免口播念到一半戛然而止。

    修复(2026-08): 旧逻辑 narration[:max_chars] 硬切片导致大量口播断在半句
    ("…他正" / "…冲了过")。优先句末标点(。！？…), 次选逗号/分号, 都找不到才硬切。
    """
    t = (text or "").strip()
    if len(t) <= max_chars:
        return t
    cut = t[:max_chars]
    # 优先句末标点
    for marks in ("。！？…", "，；、"):
        best = max((cut.rfind(m) for m in marks), default=-1)
        if best >= max_chars // 2:  # 截断点不能太靠前(至少保留一半)
            out = cut[: best + 1]
            # 逗号结尾改句号, 别停在半口气上
            if out[-1] in "，；、":
                out = out[:-1] + "。"
            return out
    return cut


async def _gemini_narration(story: str, *, duration: int, max_chars: int, fid: str) -> str:
    """把故事喂给 Gemini 生成口播文案; 超字数则以更激进的目标字数重写。返回口播(失败返回空串)。"""
    from .frameworks import NARRATION_CPS
    base = build_narration_prompt(story, duration=duration)
    llm = get_llm("generate", temperature=0.6, provider="gemini")
    narration = ""
    target = int(max(1, duration) * NARRATION_CPS)
    for attempt in range(4):
        prompt = base
        if attempt > 0 and narration and len(narration) > max_chars:
            # 每轮重试目标字数递减 15%, 逼模型真正精简而不是重复同样长度
            aggressive = max(20, int(target * (1 - 0.15 * attempt)))
            prompt = (f"{base}\n\n【上一次口播 {len(narration)} 字超过上限 {max_chars} 字, "
                      f"请大幅精简到 {aggressive} 字以内(必须完整收尾在句号上, 不许写到一半), "
                      f"重新只输出口播正文。】")
        try:
            resp = await llm.ainvoke(prompt)
            narration = _extract_content(resp)
        except Exception as e:  # noqa: BLE001
            logger.warning("frontcut %s 口播生成第%d次失败: %s", fid, attempt + 1, e)
            await asyncio.sleep(min(2 ** attempt * 2, 12))
            continue
        if narration and len(narration) <= max_chars:
            return narration
    # 兜底: 有内容则在句末标点处智能截断(不再硬切半句), 没内容返回空
    return _smart_truncate(narration, max_chars) if narration else ""


TAIL_FRAME_MARK = "【尾帧衔接要求(重要)】"


def append_tail_frame_constraint(video_prompt: str, first_frame_desc: str) -> str:
    """给 Seedance 视频提示词追加'尾帧收束到正片首帧'的硬约束, 保证前贴末帧与正片开头对齐。

    幂等: 若提示词里已含 TAIL_FRAME_MARK 则原样返回, 可在生成时安全地重复调用
    (用户在前端编辑提示词时可能把这段删掉/或旧候选压根没有, 生成前统一补齐)。
    """
    ff = (first_frame_desc or "").strip()
    if not ff or not (video_prompt or "").strip():
        return video_prompt
    if TAIL_FRAME_MARK in video_prompt:
        return video_prompt
    return (
        f"{video_prompt.strip()}\n\n"
        f"{TAIL_FRAME_MARK}本段是整条前贴的最后一段, 其最后 1-2 秒必须自然收束、定格到"
        f"下面这个画面, 与正片开头无缝衔接(参考图中已提供该画面, 它是【尾帧】目标, "
        f"不是本段的起始画面): {ff}"
    )


# 兼容旧内部调用名
_append_tail_frame_constraint = append_tail_frame_constraint


async def _split_story_two_acts(
    story: str, *, seg1_seconds: int, seg2_seconds: int,
) -> tuple[str, str, str]:
    """在【故事/想法阶段】把一段两幕故事切成 (第一幕, 第二幕, 幕间衔接说明)。

    切割策略(2026-08 用户定): 切割点选在【剧情上合理的切镜位置】——切视角/切场景/
    时间跳跃("一晃十几年")等。两段之间是一次正常的剪辑切镜, 【不要求画面无缝延续】,
    短剧本就是快节奏多切镜的。人物一致性靠各段自带的人物外观描述+主角参考图保证。
    失败抛异常, 调用方降级。
    """
    llm = get_llm("generate", temperature=0.4, provider="gemini")
    ask = (
        "你是短剧编剧/剪辑师。下面这段前贴故事将拆成两段视频分别生成、再顺序拼接播出, "
        f"请把它切成前后两幕:\n"
        f"- 第一幕约 {seg1_seconds} 秒: 开场钩子与铺垫。\n"
        f"- 第二幕约 {seg2_seconds} 秒: 承接剧情推进到故事原本的结尾(保留原结尾的收束方式)。\n"
        "- 【切割点必须是一个剧情上合理的切镜位置】: 切场景(换地点)/切视角(换人物焦点)/"
        "时间跳跃(如'一晃十几年'/'当天深夜')/因果跳接(动作抛出→结果揭晓)。"
        "两幕之间就是一次正常的剪辑切镜, 【不需要】两幕画面无缝延续, 严禁为了衔接而强行让"
        "两幕停留在同一画面。\n"
        "- 【两幕信息密度必须均衡(硬性)】: 严禁把绝大部分情节压在第一幕、留给第二幕一个"
        "又慢又空的收尾。第二幕必须自带 2 个以上新信息点(新事实/新人物/态度反转/危机升级/"
        "真相揭晓), 且与第一幕前后因果连贯、层层递进。\n"
        "- 【严禁用慢动作/过程性动作填时间(硬性)】: 任何一幕都不允许靠"
        "脱衣换衣、整理头发、缓慢起身、长时间凝视、纯风景空镜、来回踱步、重复同一动作"
        "这类无信息增量的画面撑时长。若某一幕情节不够, 应当从原故事里多分配情节过来, "
        "而不是把动作放慢。\n"
        "- 两幕合起来必须完整覆盖原故事, 不增删情节; 每幕开头都要完整交代人物外观/服装/场景"
        "(两幕各自独立成篇、可单独生成)。\n"
        "- 另给一段【切镜说明】: 用一句话说明这次切镜的类型与逻辑(例如'时间跳跃: 从少年挖蛇"
        "切到十八年后的都市写字楼'), 供后续提示词说明两段关系。\n"
        "输出格式(严格遵守, 不要任何其他解释):\n"
        "===ACT1===\n(第一幕故事文本)\n===ACT2===\n(第二幕故事文本)\n===BRIDGE===\n(切镜说明一句话)\n\n"
        f"【原故事】\n{story.strip()}"
    )
    resp = await llm.ainvoke(ask)
    text = _extract_content(resp)
    if not all(m in text for m in ("===ACT1===", "===ACT2===", "===BRIDGE===")):
        raise RuntimeError("故事两幕切割输出格式不符(缺 ACT1/ACT2/BRIDGE 标记)")
    act1 = text.split("===ACT1===", 1)[1].split("===ACT2===", 1)[0].strip()
    act2 = text.split("===ACT2===", 1)[1].split("===BRIDGE===", 1)[0].strip()
    bridge = text.split("===BRIDGE===", 1)[1].strip()
    if not act1 or not act2:
        raise RuntimeError("故事两幕切割产出为空")
    return act1, act2, bridge


async def _optimize_act(
    act_story: str, *, optimize: bool, pe_context: str, seg_note: str, fid: str,
) -> str:
    """把一幕故事优化成该段的视频提示词(seg_note=本段专属硬约束, 拼进 PE 背景)。失败回退故事原文。"""
    ctx = f"{pe_context}\n{seg_note}" if pe_context else seg_note
    if optimize:
        try:
            opt = await seedance_pe.optimize_to_prompt(
                act_story, provider="gemini", extra_context=ctx or None)
            if opt:
                return opt
        except Exception as e:  # noqa: BLE001
            logger.warning("frontcut %s 分段提示词优化失败, 回退故事原文: %s", fid, e)
    return act_story


async def _gen_one(
    framework: dict,
    *,
    reverse_summary: str,
    user_ref: str,
    optimize: bool,
    library_context: str = "",
    duration: int = 10,
    first_frame_desc: str = "",
    topic_hints: str = "",
    pe_context: str = "",
) -> dict:
    """单套框架: grok 写故事 → 并行(seedance优化视频提示词 ‖ Gemini生成口播)。

    pe_context: 传给 seedance PE 优化器的补充背景(如"本次可用参考图清单/音频规则"硬约束),
                用于杜绝优化器幻觉引用不存在的 @图片N、以及给人物乱加台词。
    """
    fid = framework["id"]
    fname = framework["name"]
    # 口播字数上限 = 时长 × NARRATION_CPS_MAX(8字/秒); 成片时音频 atempo 变速对齐画面,
    # 文本层只拦"信息量过载"的极端情况, 不再按朗读速度硬卡。
    from .frameworks import NARRATION_CPS_MAX
    max_chars = int(max(1, duration) * NARRATION_CPS_MAX)

    # 第一步: grok 写故事(输入含正片剧情+正片首帧描述, 故事终点收束到首帧画面)
    meta = build_meta_prompt(fid, reverse_summary=reverse_summary, user_ref=user_ref,
                             library_context=library_context, duration=duration,
                             first_frame_desc=first_frame_desc, topic_hints=topic_hints)
    try:
        story = await _grok_story(meta, fid=fid)
    except Exception as e:  # noqa: BLE001
        return {"framework_id": fid, "framework_name": fname,
                "prompt": "", "narration": "", "story": "", "error": f"故事生成失败: {str(e)[:200]}"}

    # 第二步: 并行把故事翻成 (视频提示词) 和 (口播文案)
    # >15s 两段式(用户定, 2026-08): 在【故事阶段】切两幕 → 两幕【分别】走提示词优化 →
    # 候选带 prompt(段1) + prompt2(段2), 前端两个框都可见可编辑, 生成时分别提交再拼接。
    two_seg = int(duration) > 15
    seg1_sec = max(5, int(duration) // 2)
    seg2_sec = max(5, int(duration) - seg1_sec)

    async def _to_video_prompt_single() -> tuple[str, str]:
        base = story
        if optimize:
            try:
                opt = await seedance_pe.optimize_to_prompt(
                    story, provider="gemini", extra_context=pe_context or None)
                base = opt or story  # 优化失败回退用故事原文
            except Exception as e:  # noqa: BLE001
                logger.warning("frontcut %s seedance优化失败, 回退故事原文: %s", fid, e)
                base = story
        # 追加尾帧收束约束(前贴末帧对齐正片首帧, 保证拼接丝滑)
        return _append_tail_frame_constraint(base, first_frame_desc), ""

    async def _to_video_prompt_two_seg() -> tuple[str, str]:
        """故事切两幕 → 两幕并行各自优化 → (段1提示词, 段2提示词)。切割失败降级单段路径。"""
        try:
            act1, act2, bridge = await _split_story_two_acts(
                story, seg1_seconds=seg1_sec, seg2_seconds=seg2_sec)
        except Exception as e:  # noqa: BLE001
            logger.warning("frontcut %s 故事两幕切割失败, 降级单段提示词: %s", fid, e)
            return await _to_video_prompt_single()
        bridge_note = f"(两段切镜关系: {bridge})" if bridge else ""
        seg1_note = (
            f"【本段定位】这是两段式前贴的第 1 段(约{seg1_sec}秒, 开场钩子){bridge_note}。"
            f"两段之间是一次正常的剪辑切镜, 本段结尾正常收束本幕剧情即可, "
            f"不要收束到正片首帧、不要加尾帧衔接段落(那是第2段的职责)。"
        )
        seg2_note = (
            f"【本段定位】这是两段式前贴的第 2 段(约{seg2_sec}秒, 切镜后的下一幕){bridge_note}。"
            f"本段开头是切镜后的新画面(不需要与第1段画面延续), 但人物外观/服装/世界观必须与第1段一致; "
            f"开头即进入本幕剧情, 严禁重复第1段内容。"
        )
        p1, p2 = await asyncio.gather(
            _optimize_act(act1, optimize=optimize, pe_context=pe_context, seg_note=seg1_note, fid=fid),
            _optimize_act(act2, optimize=optimize, pe_context=pe_context, seg_note=seg2_note, fid=fid),
        )
        # 尾帧约束只加在段2(段2末帧要接正片开头)
        return p1, _append_tail_frame_constraint(p2, first_frame_desc)

    (video_prompt, video_prompt2), narration = await asyncio.gather(
        _to_video_prompt_two_seg() if two_seg else _to_video_prompt_single(),
        _gemini_narration(story, duration=duration, max_chars=max_chars, fid=fid),
    )

    result = {"framework_id": fid, "framework_name": fname,
              "prompt": (video_prompt or "").strip(), "narration": (narration or "").strip(),
              "story": story}
    if (video_prompt2 or "").strip():
        result["prompt2"] = video_prompt2.strip()
        result["seg_seconds"] = [seg1_sec, seg2_sec]
    if not result["prompt"]:
        result["error"] = "视频提示词生成失败(故事已生成, 可重试)"
    return result


async def generate_frontcut_prompts(
    *,
    reverse_summary: str,
    user_ref: str = "",
    optimize: bool = True,
    library_context: str = "",
    duration: int = 10,
    first_frame_desc: str = "",
    topic_hints: str = "",
    pe_context: str = "",
) -> list[dict]:
    """对全部 5 套框架并发生成前贴(故事 → 视频提示词 + 口播文案)。

    first_frame_desc: 正片首帧画面描述, 让 grok 故事收束到此画面 + Seedance 提示词追加尾帧约束。
    topic_hints: 从语料库打标结果提炼的高频题材方向(可空),帮助 grok 选择更精准的切入角度。
    pe_context: 传给 seedance PE 优化器的硬约束背景(参考图清单/音频规则, 可空)。
    返回: [{framework_id, framework_name, prompt, narration, story, [error]}] × 5。
    """
    if not (reverse_summary or "").strip():
        raise ValueError("reverse_summary 为空, 无法生成前贴提示词")
    results = await asyncio.gather(*[
        _gen_one(fw, reverse_summary=reverse_summary, user_ref=user_ref,
                 optimize=optimize, library_context=library_context, duration=duration,
                 first_frame_desc=first_frame_desc, topic_hints=topic_hints,
                 pe_context=pe_context)
        for fw in FRAMEWORKS
    ])
    return list(results)


async def split_prompt_two_segments(
    prompt: str, *, seg1_seconds: int, seg2_seconds: int, first_frame_desc: str = "",
) -> tuple[str, str]:
    """把一条完整前贴提示词拆成前后两段(供 >15s 两段式顺序生成+拼接)。

    规则:
    - 第1段: 故事前半幕(开场钩子), 结尾停在一个稳定画面(将作为第2段的首帧参考图)。
    - 第2段: 故事后半幕, 开头从第1段末帧画面继续, 结尾收束到正片首帧(尾帧约束由调用方追加)。
    失败抛异常, 调用方自行降级。
    """
    llm = get_llm("generate", temperature=0.4, provider="gemini")
    ff = (first_frame_desc or "").strip()
    ff_note = (f"\n【第2段结尾必须收束的正片首帧画面】\n{ff}\n" if ff else "")
    ask = (
        "你是视频提示词工程师。下面是一条完整的 AI 视频生成提示词(讲一个前后两幕的短故事), "
        f"需要拆成两段分别生成、再顺序拼接为一条成片:\n"
        f"- 第1段约 {seg1_seconds} 秒: 覆盖故事的前半幕(开场钩子), 结尾必须停在一个"
        f"【画面稳定、构图清晰的定格瞬间】(这一帧将作为第2段的起始参考图, 要在第1段提示词末尾"
        f"用一句话明确描述这个收尾画面: 人物姿态/位置/场景/景别)。\n"
        f"- 第2段约 {seg2_seconds} 秒: 覆盖故事的后半幕, 开头第一句明确\"画面从上一段结尾的定格画面继续\", "
        f"人物外观/服装/场景与第1段严格一致; 结尾自然收束(不要自行添加尾帧衔接段落, 调用方会追加)。\n"
        "两段都要保留原提示词的全局设定(角色外观/服装/画质风格/音频规则), 每段各自完整可独立提交生成。\n"
        "严禁给人物添加台词。\n"
        "输出格式(严格遵守, 不要任何其他解释):\n"
        "===SEG1===\n(第1段完整提示词)\n===SEG2===\n(第2段完整提示词)\n"
        f"{ff_note}\n【完整原提示词】\n{prompt.strip()}"
    )
    resp = await llm.ainvoke(ask)
    text = _extract_content(resp)
    if "===SEG1===" not in text or "===SEG2===" not in text:
        raise RuntimeError("两段拆分输出格式不符(缺 SEG1/SEG2 标记)")
    seg1 = text.split("===SEG1===", 1)[1].split("===SEG2===", 1)[0].strip()
    seg2 = text.split("===SEG2===", 1)[1].strip()
    if not seg1 or not seg2:
        raise RuntimeError("两段拆分产出为空")
    # 段2 是整条前贴的最后一段 → 补齐尾帧收束约束(旧候选降级路径以前漏了这一步)
    return seg1, append_tail_frame_constraint(seg2, first_frame_desc)

