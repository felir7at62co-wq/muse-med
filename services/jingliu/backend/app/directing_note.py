"""导演意图（`directing_note`）的**唯一**取用与渲染点。

## 它是什么

拆解阶段（`do_breakdown`）除了切镜头，还要回答一个下游一直缺的问题：
**这一镜在全片里承担什么功能**。产出这些：

  · `dramatic_function` —— 建立 / 推进 / 转折 / 收束
  · `dramatic_goal`     —— 戏剧目标（这一镜要达成什么效果）
  · `core_conflict`     —— 核心冲突（对立的双方）
  · `emotional_curve`   —— 情绪曲线（用箭头串起变化过程）
  · `core_subjects`     —— 核心主体（画面围绕谁展开）
  · `required_reactions`—— 必须拍到的反应（下游安排反应镜的依据）
  · `key_visual_info`   —— 核心视觉信息（观众必须看见的要素）
  · `emotional_beat`    —— 情绪基调（一句具体、可表演的话）
  · `focus`             —— 画面最该被看见的那个东西
  · `action_intensity`  —— 动作强度（驱动规则21条）

## 为什么删掉了「景别走向」（2026-10-11）

这里曾经有 `shot_scales`（景别序列，2-5 个元素）与 `shot_scale_suggestion`。
已按外部生成师方案 §6 **删除渲染**（字段保留在库里，只为不让老项目读取出错）。

删除的理由是**职责冲突**：拆解阶段提前规定景别序列，提示词层又要重新判断
节奏，两边都想管节奏，结果互相打架。景别与机位应由提示词层按叙事需要设计。

我们自己的实测也支持删除，而且是更强的证据 —— 那个字段**有反作用**：
给 4 个元素，下游就切 4 段；给 5 个就切 5 段（项目 1011 七镜逐个应验）。
它不但没解决「中段四段挤在同一档」，还顺手把段数锁死了。

而「中段打转」这个真问题，现在由出品硬规则**第 1 条的硬约束**来治：
连续两段不得同时保持 `同主体 + 同尺度 + 同机位方向 + 同空间关系`，
**且「尺度」按四档比**（超特写/近/中/远）而不是按景别原名比。
那是**判据**，不是预设序列 —— 判据能被违反、因而能被纠正；
预设序列只会被当成清单填。

## 为什么必须由拆解给（2026-09-20）

提示词优化器原先拿到的只有剧本文本 + 一份「禁止清单」。它不知道这一镜要干什么，
只能把剧本**翻译**一遍 —— 而人工精品之所以好，是因为导演先决定了这一镜的目的，
再由摄影与表演去服务它。

实测 7147 条真实提示词印证了这一点：光线覆盖 13.6%、景深 7.3%、
机位角度 28.2% —— 缺的正是「这一镜要什么」。补上导演意图后重跑同一剧本，
三项全部到 100%（见 `backend/scripts/verify_prompt_quality_ab.py`）。

## 存储与兼容

落在 `Shot.profile_override` 这个既有的 per-shot JSON 覆盖列里，**不新增数据库列**：

    {"directing_note": {"dramatic_function": "turn", ...}}

本次改动之前拆解的项目都没有这个键 —— 那时返回空串，提示词生成退回原行为，
**不影响老项目出片**。

## 为什么单独成模块

它在 `jobs.py` 里有两个消费点（预生成 `_pregen_prompts` 与出片 `_build_prompt_ctx`），
措辞必须完全一致（同一套 `_FN_LABEL` 映射、同一段引导句），否则两条路径产出的
提示词会分叉。放这里一份，两边都调它。
"""
from __future__ import annotations

import json

from .db import Shot, get_session

#: `dramatic_function` 的取值 → 给优化器看的中文释义。
#: 这三个词（establish/advance/turn/resolve）是拆解提示词里约定好的取值，
#: 未登记的取值原样透出（不丢信息，只是少了解释）。
_FN_LABEL = {
    "establish": "建立（交代空间/人物关系/情境）",
    "advance": "推进（发生了一件事，剧情向前走）",
    "turn": "转折（情绪或局势逆转，本镜是钩子）",
    "resolve": "收束（落点、情绪释放或余味）",
}

#: `action_intensity` → 喂给优化器的措辞。
#: 只有 `high` 会触发规则21条（动作镜口径）；`none` 不渲染，
#: 免得给每一个对话镜都挂一句没用的话、稀释其余导演意图。
_ACTION_LABEL = {"high": "高", "light": "中"}



def load_directing_note(shot_id: str) -> dict:
    """取本镜的导演意图。返回 `{}` = 没有（老项目 / 拆解时模型没给）。"""
    with get_session() as s:
        sh = s.get(Shot, shot_id)
        if not sh or not sh.profile_override:
            return {}
    try:
        ov = json.loads(sh.profile_override)
    except (ValueError, TypeError):
        return {}
    if not isinstance(ov, dict):
        return {}
    dn = ov.get("directing_note")
    return dn if isinstance(dn, dict) else {}


def render_directing_note(dn: dict) -> str:
    """把导演意图渲染成喂给优化器的一段话。空 dict → 空串。

    ⚠️ 措辞是**两条消费路径共用**的：预生成与出片各调一次，
    必须完全一致，否则同一镜在两条路上的提示词会分叉。

    ## 2026-10-11 重构：删景别走向，改为「目标 + 反应 + 视觉信息」

    外部生成师方案 §6 点名删掉 `shot_scales`（景别走向），理由是
    **职责冲突**：拆解阶段提前规定景别序列，提示词层又要重新判断节奏，
    两边都想管节奏，结果互相打架。景别与机位应由提示词层按叙事需要自己设计。

    这条我们自己的实测也支持：`shot_scales` 给 4 个元素时，模型就切 4 段
    （项目 1011 七镜逐个应验）—— 它不但没解决"中段打转"，
    还顺手把段数锁死了。而"中段四段挤在同一档"这个真问题，
    已由新规则11条的**硬约束**（连续两段不得同主体+同尺度+同机位方向+
    同空间关系，且尺度按四档比）来治 —— 那是判据，不是预设序列。

    新字段组（方案 §6）：戏剧目标 / 核心冲突 / 情绪曲线 / 核心主体 /
    必须拍到的反应 / 核心视觉信息 / 动作强度。
    """
    if not dn:
        return ""
    bits: list[str] = []
    fn = dn.get("dramatic_function")
    if fn:
        bits.append("戏剧功能=" + _FN_LABEL.get(fn, str(fn)))
    #: 新字段组（2026-10-11，替代 shot_scales）。逐项渲染、缺项跳过，
    #: 与旧字段并存 —— `dramatic_function`/`emotional_beat`/`focus` 是
    #: 老项目已有的，不能因为换了口径就让它们丢掉。
    for key, label in (
        ("dramatic_goal", "戏剧目标"),
        ("core_conflict", "核心冲突"),
        ("emotional_curve", "情绪曲线"),
        ("core_subjects", "核心主体"),
        ("required_reactions", "必须拍到的反应"),
        ("key_visual_info", "核心视觉信息"),
    ):
        v = dn.get(key)
        if isinstance(v, list) and v:
            bits.append(f"{label}=" + "、".join(str(x).strip() for x in v if str(x).strip()))
        elif v and str(v).strip():
            bits.append(f"{label}={str(v).strip()}")
    if dn.get("emotional_beat"):
        bits.append("情绪基调=" + str(dn["emotional_beat"]))
    if dn.get("focus"):
        bits.append("画面最该被看见的=" + str(dn["focus"]))
    #: ⚠️ `shot_scales` / `shot_scale_suggestion` **不再渲染**（2026-10-11）。
    #: 老项目的库里仍有这两个字段，这里**刻意忽略**它们：
    #: 保留渲染就等于把已废除的"上游规定景别序列"又灌回去。
    #: 字段本身不删（避免老项目读取出错），只是不再进提示词。
    # 动作强度（2026-09-23）：措辞必须与规则21条的触发条件**逐字一致**
    # （那里写的是「导演意图标明 `动作强度=高`」）。对不上就等于没触发 ——
    # 规则 21 会覆盖第 1 条（视觉节拍）、第 3 条（反应镜）与第 11 条（运镜），
    # 那三条是文戏口径，对武戏正好是反作用（项目 923 实测：固定机位 56 次 :
    # 运镜 8 次，27 秒的战斗镜被写成六张静态构图）。
    ai = str(dn.get("action_intensity") or "").strip().lower()
    if ai in _ACTION_LABEL:
        bits.append("动作强度=" + _ACTION_LABEL[ai])
    if not bits:
        return ""
    return ("本镜的导演意图（拆解阶段已定，提示词必须落实它；"
            "景别、机位与切几刀由你按叙事需要设计）：" + "；".join(bits))


def project_prompt_context(project_id: str, *, used_first_frame: bool = False) -> list[str]:
    """本项目的**画风与影调**声明 —— 两条路径共用的那两句。

    ## 为什么抽出来（2026-09-20）

    这两句原先只存在于出片路径（`_build_prompt_ctx`），预生成路径完全没有 ——
    而 `run_shot_videos` 有一条快路径：「有 pregen 且无参考图无首帧 → 直接下发
    预生成稿，不再重新优化」。走那条路时画风与影调**彻底丢失**。

    实测后果：7147 条真实提示词里含「全片画风」的仅 **0.1%** —— 视频模型
    只能按训练均值走，那正是「塑料感 / 通用脸」的来源之一。

    两者都与资产无关（画风来自项目档案、影调来自影调档案），拆解阶段就能给，
    所以两条路径都用同一个函数，措辞不会有第二份。

    `used_first_frame` 为真时影调那句会追加一句"首帧已按这套影调出图" ——
    首帧路线下首帧图已定调，重复要求调色反而会让模型重调一遍。
    """
    from . import style_preset as _sp
    from .look_profile import load as _look_load, phrase as _look_phrase

    out: list[str] = []
    # 画风：**全参考路线没有首帧图**，视频模型只看提示词与定妆图，
    # 不在这里声明就会出成实拍 —— 比色调不统一严重得多。
    #
    # 渲染管线词（`render_line`）紧跟其后、**同一个元素**：它必须与画风
    # 原子地一起进退。分两个元素会有一个说不清的中间态 ——
    # 某个调用方只取了 `[0]`（画风）就把它丢了，正是本函数要消灭的那类疏漏。
    # 四档留空的画风拼出来逐字等于今天（零改动）。
    st = _sp.load(project_id)
    out.append(st.video_line + (st.render_line or ""))
    # 影调：全片一套调色配方，视频侧也必须说（与资产图共用同一份档案）。
    look = _look_load(project_id)
    line = _look_phrase(look) if look else ""
    if line:
        out.append(line + ("首帧图已按这套影调出图，视频沿用即可，不要重新调色。"
                           if used_first_frame else ""))
    return out
