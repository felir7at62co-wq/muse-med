"""提示词生成的**上下文组装**与**最终拼装** —— 唯一实现（2026-11-10 重写）。

⚠️ **2026-11-19 起本模块已无调用方（死代码，可整体删除）。** 它是镜流自带提示词引擎
（`prompt_opt.optimize_full`）的输入组装与产物拼装；镜头脚本改由 Muse 撰写并锁定之后，
引擎与它的四个入口（预生成 / 出片兜底 / 重新生成提示词 / AI 改写）都已删除。
出片时锁定稿**原样**下发，不再经过这里的 `compose_final`。下面是当时的设计说明，留作参考。

## 为什么重写

用户报告：拆解与生成提示词时出现严重的吞台词、加戏、说话人错。排查结论见
`docs/ANALYSIS-提示词上下文组装-2026-11-10.md`，方案见
`docs/PLAN-提示词上下文重组-2026-11-10.md`。一句话：

    旧 ctx 有 15 类段落（参考图清单、人物档案、在场名单、场景设定、前情剧本、
    段首提示词……），全部挂在「优先级高于原稿，冲突时以此为准」之下。
    其中两段带着**别的镜头的台词**；其余段落互相矛盾时模型只能拒答，
    拒答又被静默回退成剧本原文发给视频模型。

## 新口径（用户 2026-11-10 裁定）

**提示词模型只拿两样东西：本镜原文 + 提示词框架。** 外加一行本镜参数（时长）。

其余信息要么不需要（参考图由下发前的 `at_refs` 确定性绑定，模型只写名字；
人物代词跟原文走），要么由代码**确定性拼进最终提示词**，不经过模型：

    [画风 + 渲染规格]          ← lock_style_line（已有）
    [影调]                     ← 本模块 compose_final
    [开场站位：……]             ← 同场连续时才有，来自上一镜的站位分析
    [提示词模型写的正文]
    [无字幕、无文字、无水印]    ← 固定后缀

动作戏：**不再由拆解标注**。本镜原文命中动作词表就在 system 里追加
动作镜条款（规则 21），否则不追加 —— 机械判定，不给模型看任何标签。

## 两个入口必须共用

预生成（拆解后写初稿）、出片、重新生成提示词、AI 改写 —— 四条路径都只走
`build_user_message` + `compose_final`。旧代码就是因为"同一套约束在两处各写一遍、
改了一处忘了另一处"反复出事。
"""
from __future__ import annotations

import logging
import re

log = logging.getLogger("fw.prompt_compose")

#: 固定后缀。原来由出品规则第 19 条让模型自己写，模型有时写有时不写、
#: 措辞也不统一（实测出现过「画面底部同步显示字幕」这种反着来的）。
#: 改成确定性拼接后，规则 19 仍然约束模型**正文里**别写字幕，后缀负责兜底。
NO_TEXT_SUFFIX = "画面全程无字幕、无文字、无水印、无标志。"

#: 开场站位前缀的标记。幂等判据靠它：同一份提示词重复拼装不会叠出两行。
BLOCKING_MARK = "开场站位："


# ---------------------------------------------------------------- 动作戏判定

#: 高强度动作词表。命中任意一个 → 本镜按动作戏写（追加规则 21）。
#:
#: 只收**打斗/追逐/爆炸/坠落**这一档（原 `action_intensity=high` 的定义）。
#: 推门、奔跑、跌倒、拥抱这类"有肢体动作但不是武戏"的不收 —— 规则 21 会把
#: 镜头改成一镜一动作 + 强制运镜，套在文戏上是反作用（项目 923 之前的教训
#: 反过来也成立：文戏被武戏口径污染会平白多出运镜与飞溅的尘屑）。
#:
#: 宁可漏判（按文戏写，与改动前未标注时的行为一样）也不错判。
ACTION_WORDS = (
    "打斗", "厮杀", "搏斗", "格斗", "交手", "过招", "缠斗", "激战", "混战", "鏖战",
    "拳打脚踢", "挥拳", "出拳", "一拳", "重拳", "飞踢", "一脚踹", "踹飞", "踹开", "踢飞",
    "挥刀", "拔刀", "砍向", "劈向", "劈下", "刺向", "一剑", "挥剑", "拔剑", "刀光", "剑光",
    "开枪", "枪声", "射击", "扣动扳机", "子弹", "中弹",
    "爆炸", "炸开", "炸裂", "引爆",
    "追杀", "追逐", "狂奔追", "飞扑", "扑倒在地", "扭打", "撕打", "厮打",
    "坠落", "跌落悬崖", "从高处坠",
    "掐住脖子", "锁喉", "过肩摔", "撞飞", "击飞", "震飞",
)

#: 词表命中但**不是动作**的固定搭配（dev 实测误判样本）：
#: 「爆炸头」是发型，「爆炸性指令/消息」是修辞。
_ACTION_FALSE = re.compile(r"爆炸头|爆炸性")

_ACTION_RE = re.compile("|".join(re.escape(w) for w in ACTION_WORDS))


def is_action_scene(script_ref: str) -> bool:
    """本镜原文是不是高强度动作戏（机械判定，见 `ACTION_WORDS`）。

    只看**画面描述行**（△ 行 / 非台词行），不看台词：台词里说「被他一剑砍了」
    是在讲述，不是这一镜要拍的动作（dev 实测误判样本 c415d54aa8d0）。
    """
    from .drama_timing import split_units
    return any(u.kind == "action" and _ACTION_RE.search(_ACTION_FALSE.sub("", u.raw))
               for u in split_units(script_ref or ""))


# ---------------------------------------------------------------- 给提示词模型的输入

def build_user_message(script_ref: str, duration_sec: float | None) -> str:
    """提示词模型的 user 消息：**本镜原文 + 一行时长**，别无其它。

    时长为什么还要给：提示词要写时间码、决定切几刀（规则 4 按事件估段长），
    不知道总长就排不了；而它是本镜自己的参数，不是"别的文本"，不构成污染。
    """
    ref = (script_ref or "").strip()
    if duration_sec and duration_sec > 0:
        return f"本镜时长：{float(duration_sec):.1f} 秒\n\n本镜剧本原文：\n{ref}"
    return f"本镜剧本原文：\n{ref}"


#: 第一人称叙述的判定：**动作主体是「我」**。
#:
#: 判据是"叙述视角"，不是"有没有这个字"：「我们」「我家」「给我」「一份」都不算。
#: 实测口径（dev 全库 12659 镜）：命中约 8%，且命中集里几乎全是「我 + 动词」开头的
#: 句子 —— 这些正是模型会凭空画一个"我"出来的地方。
#:
#: ⚠️ 不能只看 `split_units` 的 dialog 单元：剧本写「我往后退了两步，震惊道：“…”」时，
#: 整行被判成 `action`（行首不是「我：」），说话人是「我」这件事只能从原文里认。
_FIRST_PERSON_SUBJ = re.compile(
    r"(?:^|[。！？!?\n”』」])\s*(?:△|▲)?\s*我\s*"
    r"(?=[，,。！？…]|往|把|握|伸|看|听|说|问|走|站|坐|转|抬|低|皱|叹|笑|拿|摸|"
    r"推|拉|抓|蹲|起|回|冲|跟|朝|向|在|从|被|愣|盯|咽|摊|捂|抱|背|穿|戴|凑|凑近)"
)
#: 说话人就是「我」：`我：“…”` / `我os：` / `我（低声）：`
_FIRST_PERSON_SPK = re.compile(r"(?:^|[。！？\n”』」])\s*(?:△|▲)?\s*我\s*(?:os|OS)?\s*(?:[（(【][^）)】]{0,20}[）)】])?\s*[:：]")


def is_first_person(script_ref: str) -> bool:
    """本镜原文是不是第一人称叙述（见 `_FIRST_PERSON_SUBJ`）。"""
    ref = script_ref or ""
    return bool(_FIRST_PERSON_SPK.search(ref) or _FIRST_PERSON_SUBJ.search(ref))


# ---------------------------------------------------------------- 最终拼装

def compose_final(project_id: str, body: str, blocking_line: str | None) -> str:
    """把提示词模型的正文拼成最终提示词（确定性，幂等）。

    顺序：画风+渲染规格 → 影调 → 开场站位 → 正文 → 无字幕后缀。

    幂等：已含对应段落的不再重复拼（提示词会在预生成、出片、重写之间多次过这里）。
    `blocking_line=None` 表示"不改动站位行"；传空串表示"本镜不该有站位"——
    会剥掉旧的站位行（例如本镜变成了换场首镜）。
    """
    from .jobs import lock_style_line

    # 先把可能已存在的确定性段落全部剥掉（后缀、站位、影调、非 3D 画风），
    # 再按固定顺序重拼 —— 顺序稳定是幂等的前提：只"缺了才补"的话，
    # 第二遍会把站位行插到画风行前面，同一份稿子越拼越乱。
    text = _strip_suffix((body or "").strip())
    old_blocking, text = _pop_blocking(text)
    if blocking_line is None:
        blocking_line = old_blocking
    look = _look_line(project_id)
    plain_style = _plain_style_line(project_id)
    text = _drop_lines(text, [x for x in (look, plain_style) if x])

    head: list[str] = []
    if plain_style:
        head.append(plain_style)      # 非 3D 四档的画风（3D 两档由 lock_style_line 拼）
    if look:
        head.append(look)
    if blocking_line:
        head.append(f"{BLOCKING_MARK}{blocking_line.strip()}")
    text = "\n".join(head + ([text] if text else []))
    # 3D 两档：画风 + 渲染规格拼在最前（自带时代换头与幂等，见其文档）
    text = lock_style_line(project_id, text)
    if text:
        text = f"{text}\n{NO_TEXT_SUFFIX}"
    return text


#: 时间码行（提示词正文的第一个结构标志）。
_TC_LINE = re.compile(r"^\s*\d+(?:\.\d+)?\s*[–\-~～至]\s*\d+(?:\.\d+)?\s*秒", re.M)

def _drop_lines(text: str, exact: list[str]) -> str:
    """剥掉与 `exact` 中任一项**整行相等**的行（只剥确定性拼进来的那几行）。"""
    if not exact:
        return text
    keep = [l for l in (text or "").splitlines() if l.strip() not in exact]
    return "\n".join(keep).strip()


def _plain_style_line(project_id: str) -> str:
    """非 3D 四档的「全片画风：…」（3D 两档返回空，交给 lock_style_line）。

    ⚠️ 这四档（真人 / 古装真人 / 厚涂 / 国漫）以前**只靠 ctx** 把画风送进去，
    ctx 取消后必须在这里确定性补上，否则真人剧可能出成动画
    （全参考路线没有首帧图，视频模型只看提示词与定妆图）。
    """
    try:
        from . import style_preset as _sp
        st = _sp.load(project_id)
    except Exception as e:  # noqa: BLE001 画风读不到不该让出片失败
        log.warning("[compose] 读画风失败，跳过：%r", e)
        return ""
    if st.render_line or not st.video_line:
        return ""
    return st.video_line.strip()


def _strip_suffix(text: str) -> str:
    t = text.rstrip()
    while t.endswith(NO_TEXT_SUFFIX):
        t = t[: -len(NO_TEXT_SUFFIX)].rstrip()
    return t


def _pop_blocking(text: str) -> tuple[str | None, str]:
    """剥掉文本里的「开场站位：」行，返回 (站位内容或 None, 剩余文本)。"""
    found = None
    keep = []
    for line in (text or "").splitlines():
        if line.startswith(BLOCKING_MARK):
            found = line[len(BLOCKING_MARK):].strip() or found
            continue
        keep.append(line)
    return found, "\n".join(keep).strip()


def _look_line(project_id: str) -> str:
    """影调一句（与资产图共用同一份档案）。读不到就不拼，不能因此挡住出片。"""
    try:
        from .look_profile import load as _load, phrase as _phrase
        look = _load(project_id)
        return _phrase(look) if look else ""
    except Exception as e:  # noqa: BLE001
        log.warning("[compose] 读影调失败，跳过：%r", e)
        return ""


# ---------------------------------------------------------------- 站位

def blocking_for(sid: str) -> str:
    """本镜开场该拼的站位行（纯文本）。只在**同场连续**时返回非空。

    来源是上一镜的 `blocking_out`（由 `blocking.analyze_and_save` 在上一镜
    提示词生成后写入，内容是"上一镜结束时谁在哪"）。

    判据与 `_scene_run_ctx` 原来用的同源：`continuity.cached_runs` 的连续段。
    本镜是段首（换场 / 一场戏第一镜）→ 不拼。
    """
    from .continuity import cached_runs
    from .db import Shot, get_session

    with get_session() as s:
        cur = s.get(Shot, sid)
        if cur is None:
            return ""
        run_ids = next((r for r in cached_runs(s, cur.project_id) if sid in r), None)
        if not run_ids or run_ids.index(sid) == 0:
            return ""
        prev = s.get(Shot, run_ids[run_ids.index(sid) - 1])
        return plain_blocking(prev.blocking_out if prev else None)


def plain_blocking(raw: str | None) -> str:
    """`blocking_out` → 一行纯文本。

    新格式就是纯文本；老格式是 JSON 台账（2026-11-10 之前出片时写的），
    用 `continuity.blocking_text` 的渲染兜底读出来 —— 老项目不用重跑。
    """
    t = (raw or "").strip()
    if not t:
        return ""
    if not t.startswith("{"):
        return t
    try:
        from .continuity import parse_blocking
        b = parse_blocking(t)
        if not b:
            return ""
        parts = []
        for name, f in b.items():
            bits = [f.get("posture", ""), "在" + f["pos"] if f.get("pos") else "",
                    f.get("facing", ""), f.get("prop", "") if f.get("prop") != "无" else ""]
            parts.append(name + "".join(x for x in ("，".join(b for b in bits if b),) if x))
        return "；".join(parts)
    except Exception:  # noqa: BLE001
        return ""
