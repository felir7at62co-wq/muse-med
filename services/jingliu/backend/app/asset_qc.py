"""asset_qc.py — 资产图体检。**两套判据，互补，缺一不可。**

## 两套判据

| | 本地客观体检 | 视觉核验 |
|---|---|---|
| 入口 | `inspect` / `report` | `check_scene` / `check_character` / `describe` |
| 时机 | 出图后自动跑（`jobs.py:631`） | 用户点「视觉体检」（`POST /v2/assets/{id}/qc`） |
| 成本 | **零**（本地 PIL，不出网） | 每次调用走多模态模型，**花钱** |
| 抓什么 | 文件坏了 / 纯色 / 灰底 / 画幅不对 | 场景图里有没有人、人物图里有没有场景、三视图与标注 |
| 判不了 | 语义（图里有没有人） | 像素级缺陷（它只会说"看着不对"） |

⚠️ **历史教训**：2026-09-21 的 `a668d8c` 用第一套整份替换了本模块，
把第二套的三个函数删了，而 `look.py` 的端点还在调它们 ——
用户点「视觉体检」必 500，持续了一个多月没人发现（因为它只在用户主动点时炸）。
那次提交的意图是"新增客观体检"，不是"删掉视觉体检"，它没意识到自己覆盖的是另一个功能。
恢复见下方 `第二套判据` 一节。

## 本地客观体检刻意**不**做什么

计划里的 P2-3 原本写的是"资产图质检回路（当前无候选图机制，一次生成即采用，
没有挑选余地）"，即**生成 N 张候选、挑最好的一张**。本模块**刻意不做那个**，
两个理由都是硬的：

1. **"最好的一张"没有可靠判据。** 本次改造全程的结论就是
   "图像质量没有可靠的单一标量，任何『谁分高谁好』的结论都是自欺"
   （见 `scripts/verify_asset_image_ab.py` 的 `measure()`）。
   拿一个我自己都判定不可信的分数去自动挑图，是把不确定性伪装成确定性。
2. **自动重试在花钱的路径上。** 实测 E 之后 4/4 角色图背景都是纯白 254，
   说明提示词本身已经把主要缺陷治住了；此时加一个几乎不触发、
   却可能因判据偏差而误触发的重试循环，是拿成本换一个已经不存在的问题。

所以本地体检只做**能见度**：把"这张图客观上坏了"记成日志，
让用户能定位到具体是哪个角色/场景出了问题，再用现有的「重新生成」自行处理。
**零成本、零风险、不改变任何出图行为。**

## 本地判据只取「缺陷级」，不取「审美级」

每一条都是"这张图不能用"，而不是"这张图不够好看"：

| 代码 | 含义 | 阈值来源 |
|---|---|---|
| `unreadable` | 文件打不开或尺寸为 0 | —— |
| `blank` | 画面近乎单色（生成失败的典型形态） | 全图灰度标准差 < 6 |
| `bg_not_white` | **角色图**背景不是纯白 | 实测：改造后 4/4 为 254，改造前为 107–187 |
| `aspect_mismatch` | 返回画幅与请求不符 | 长宽比相对误差 > 12% |

`bg_not_white` **只对角色图判**：场景图本来就不该是白底，对它判这条是错的。
"""
from __future__ import annotations

import logging

log = logging.getLogger(__name__)

#: 角色图背景判白的阈值。实测：改造后四张的四边中位亮度全是 **254**，
#: 改造前是 120/107/187/161。240 这条线离两边都远，不会因为一点压缩噪声误判。
_WHITE_MIN = 240

#: 判"整张图近乎单色"的灰度标准差下限。正常成图远在此之上
#: （实测样本的人物内部标准差在 56 上下）。取 6 是为了只抓住
#: "纯色/几乎全白/几乎全黑"这类**生成失败**，不误伤低反差但正常的图。
_BLANK_SD = 6.0

#: 画幅误差容忍度。渠道会返回比请求略大的尺寸（实测请求 1024 返回 1254），
#: 但**比例**应当一致，所以判比例不判绝对尺寸。
_ASPECT_TOL = 0.12


# ============================================================================
# 第二套判据：视觉核验（按需触发，花钱）
# ============================================================================
#
# ⚠️ 这两套判据是**互补的，不是替代关系**，别再把其中一套删掉：
#
#   `inspect` / `report`  —— 本地 PIL，**零成本**，出图后自动跑，只抓
#                            "文件坏了/纯色/灰底/画幅不对"这类客观缺陷。
#   `check_scene` / `check_character` —— 多模态模型，**花钱**，只在用户点
#                            「视觉体检」时跑，抓的是"场景图里有没有人、
#                            人物图里有没有场景"这类语义问题。
#
# 2026-09-21 的 `a668d8c` 把整个模块重写成只有前一套，`look.py` 的
# `POST /v2/assets/{id}/qc` 仍在调用被删掉的 `check_scene` /
# `check_character` / `describe`，导致**用户点「视觉体检」必 500**。
# 那次提交的意图是"新增客观体检"，不是"删掉视觉体检"——它没意识到
# 自己覆盖的是另一个功能。故此处按 2aa8b75 原样恢复。
#
# 为什么语义判据只能用多模态模型：判"这张图里有没有人"用人脸检测确实更便宜，
# 但要判的其实是四件事：① 有没有人/人体局部/人像替代物 ② 有没有场景元素
# ③ 是不是三视图 ④ 左上角有没有名称标注、有没有多余文字。②③④ 没有现成
# 检测器，写规则更不靠谱。而 `vision_desc` 已经在用 `gpt-5.6-terra` 做
# "看图写造型"（实测 3/3 成功、平均 8.2s），同一条通道多问四个是非题最省。

#: 体检项 → 人读的说明。前端直接展示这里的文案，不自己拼句子。
ISSUE_LABELS = {
    "has_person": "场景图里出现了人物或人像替代物",
    "has_scene": "人物图里出现了场景元素（地面/家具/门窗/环境）",
    "not_three_view": "不是正面+侧面+背面三视图",
    "no_name_label": "左上角缺少名称标注",
    # 角色图用 extra_text（纯白背景上任何多余字都是缺陷）；
    # 场景图用 overlay_text（招牌车牌是空间的一部分，见 check_scene 的说明）
    "extra_text": "画面里有多余文字/水印（除左上角标注外）",
    "overlay_text": "画面上叠加了水印/字幕/台标/分镜框编号",
    "bg_not_white": "背景不是纯白干净背景",
}

_SYS_CHAR = (
    "你是影视剧组的资产质检员。看这张**角色定妆图**，只回答事实，不做评价。\n"
    "\n"
    "严格按 JSON 输出，不要 markdown 代码块、不要任何解释：\n"
    '{"three_view": true/false, "person_count": 数字, "has_scene": true/false,\n'
    ' "bg_white": true/false, "name_label_topleft": true/false,\n'
    ' "extra_text": true/false, "note": "一句话说明看到的问题"}\n'
    "\n"
    "判定口径（很重要，按这个来）：\n"
    "1. three_view：画面里是否**并排呈现同一个人的正面、侧面、背面三个全身站姿**。"
    "只有一个人站姿 = false。\n"
    "2. person_count：画面里出现了几个**人物形象**。三视图是同一个人的三个视角，"
    "这种情况请填 1。\n"
    "3. has_scene：画面里是否出现**任何场景元素**——地面/地平线/地板、墙面/墙角、"
    "门窗、家具摆件、室内外环境、天空风景、明显的空间透视或景深、"
    "人物脚下的投影或倒影。有任何一项就是 true。\n"
    "4. bg_white：背景是否为**纯白干净空白背景**（无渐变、无纹理、无影棚灰）。\n"
    "5. name_label_topleft：**左上角**是否有中文姓名文字标注。\n"
    "6. extra_text：除左上角那处标注之外，画面里是否还有其它文字/字母/数字/水印/LOGO。\n"
)

_SYS_SCENE = (
    "你是影视剧组的资产质检员。看这张**场景参考图**（应为空镜头），"
    "只回答事实，不做评价。\n"
    "\n"
    "严格按 JSON 输出，不要 markdown 代码块、不要任何解释：\n"
    '{"person_count": 数字, "person_kind": "无|完整人物|人体局部|人像替代物",\n'
    ' "name_label_topleft": true/false, "overlay_text": true/false,\n'
    ' "diegetic_text": true/false, "note": "一句话说明看到的问题"}\n'
    "\n"
    "判定口径（很重要，按这个来）：\n"
    "1. person_count：画面里出现了几个人。**以下都要计入**：\n"
    "   · 完整人物、人影、剪影\n"
    "   · **人体局部**：一只手、手臂、脚、腿、背影、半身\n"
    "   · **人像替代物**：墙上的人物照片/海报/画像/壁画、人形雕塑与胸像、"
    "服装模特与人体模型、镜子里的人影\n"
    "   一个都没有就填 0。\n"
    "2. person_kind：上面计入的是哪一类（都没有填「无」）。\n"
    "3. name_label_topleft：**左上角**是否有中文场景名称文字标注。\n"
    "4. overlay_text：除左上角那处标注之外，是否有**叠加在画面之上**的文字——"
    "水印、字幕条、台标 LOGO、分镜框编号、拼版格子里的标签。"
    "这类文字不属于被拍摄的空间，是废片标志。\n"
    "5. diegetic_text：**空间里本来就有**的文字——店铺招牌、路牌、车牌、门牌、"
    "书脊、包装字。这类是真实空间的一部分，如实报即可，不是缺陷。\n"
    "\n"
    "第 4、5 项**务必分开判**：一块挂在楼上的店铺招牌算 diegetic_text，"
    "不算 overlay_text。\n"
)

_USER_CHAR = "请质检这张角色定妆图。"
_USER_SCENE = "请质检这张场景参考图。"


def _parse(raw: str | None) -> dict | None:
    """宽容解析模型输出的 JSON（偶尔会裹代码块或前后加话）。"""
    import json
    t = (raw or "").strip()
    if not t:
        return None
    i, j = t.find("{"), t.rfind("}")
    if i < 0 or j < i:
        log.warning("[qc] 输出里找不到 JSON：%s", t[:120])
        return None
    try:
        d = json.loads(t[i:j + 1])
    except ValueError as e:
        log.warning("[qc] JSON 解析失败：%s | %s", e, t[i:j + 1][:120])
        return None
    return d if isinstance(d, dict) else None


def _as_bool(v) -> bool:
    """模型有时给 "true"/"是"/1 而不是 JSON true。"""
    if isinstance(v, bool):
        return v
    if isinstance(v, (int, float)):
        return bool(v)
    return str(v or "").strip().lower() in ("true", "yes", "1", "是", "有")


def _as_int(v) -> int:
    try:
        return int(float(v))
    except (TypeError, ValueError):
        return 0


async def check_character(image_url: str, *, expect_three_view: bool = True,
                          expect_name_label: bool = True) -> dict | None:
    """体检一张角色定妆图。返回 `{"ok","issues","raw"}`；调用失败返回 None。

    `expect_three_view` / `expect_name_label`：老资产图是单视图、无标注的口径
    （2026-09-09 之前生成的），对它们不该报这两项——那不是缺陷，是代际差异。
    """
    d = await _ask(_SYS_CHAR, _USER_CHAR, image_url)
    if d is None:
        return None
    issues: list[str] = []
    if expect_three_view and not _as_bool(d.get("three_view")):
        issues.append("not_three_view")
    if _as_bool(d.get("has_scene")):
        issues.append("has_scene")
    if not _as_bool(d.get("bg_white")):
        issues.append("bg_not_white")
    if expect_name_label and not _as_bool(d.get("name_label_topleft")):
        issues.append("no_name_label")
    if _as_bool(d.get("extra_text")):
        issues.append("extra_text")
    return {"ok": not issues, "issues": issues,
            "note": str(d.get("note") or "")[:200], "raw": d}


async def check_scene(image_url: str, *, expect_name_label: bool = True) -> dict | None:
    """体检一张场景参考图。返回 `{"ok","issues","raw"}`；调用失败返回 None。

    ⚠️ **景物自带的文字不算缺陷**。2026-09-09 实测「日 外 街道」8 张图：
    6 张通过，2 张仅因车牌与楼体招牌被报为"多余文字"。若把这也算不合格，
    每一个街景、店铺、办公楼场景都会永远挂着红色"不合格"——虚警多到用户
    直接无视体检，那这道核验就白做了。所以只有**叠加在画面之上**的文字
    （水印/字幕/台标/分镜框编号）才是缺陷；招牌车牌门牌如实记在
    `diegetic_text` 里、进 note，但不进 `issues`。
    """
    d = await _ask(_SYS_SCENE, _USER_SCENE, image_url)
    if d is None:
        return None
    issues: list[str] = []
    if _as_int(d.get("person_count")) > 0:
        issues.append("has_person")
    if expect_name_label and not _as_bool(d.get("name_label_topleft")):
        issues.append("no_name_label")
    # 老结论里只有 extra_text（没分叠加/景物两类），回退时按叠加处理，
    # 免得历史 qc_json 里的判定被静默降级成"通过"。
    if _as_bool(d.get("overlay_text") if "overlay_text" in d else d.get("extra_text")):
        issues.append("overlay_text")
    return {"ok": not issues, "issues": issues,
            "diegetic_text": _as_bool(d.get("diegetic_text")),
            "note": str(d.get("note") or "")[:200], "raw": d}


async def _ask(system: str, user: str, image_url: str) -> dict | None:
    if not (image_url or "").strip():
        return None
    from .providers.llm import LLMProvider
    try:
        llm = LLMProvider()
        raw = await llm.complete_vision(system, user, image_url, temperature=0.0)
    except Exception as e:                  # noqa: BLE001
        # 体检是质量增强，渠道抽风不该影响任何出图流程（见模块头）
        log.warning("[qc] 视觉体检失败（%s）：%s", image_url[:80], e)
        return None
    return _parse(raw)


def describe(result: dict | None) -> str:
    """体检结论 → 一句人读的话（给前端和日志共用，避免两处各拼一遍）。"""
    if result is None:
        return "体检未完成（视觉通道不可用）"
    if result.get("ok"):
        # 招牌/车牌照实说明，免得用户以为体检没看见
        return ("体检通过（画面内有招牌/路牌/车牌等景物文字，属空间的一部分）"
                if result.get("diegetic_text") else "体检通过")
    names = [ISSUE_LABELS.get(i, i) for i in (result.get("issues") or [])]
    tail = f"；模型备注：{result['note']}" if result.get("note") else ""
    return "、".join(names) + tail


def inspect(path, *, is_character: bool, want_size: str | None = None) -> list[str]:
    """体检一张已落盘的资产图，返回缺陷代码列表（无缺陷则空列表）。

    **绝不抛异常**：体检失败不能连累出图。任何内部错误都当作"没检出问题"，
    因为误报一个缺陷比漏报更糟 —— 前者会让用户去重新生成一张本来没问题的图。
    """
    try:
        import numpy as np
        from PIL import Image

        with Image.open(path) as im:
            w, h = im.size
            if not w or not h:
                return ["unreadable"]
            # 有 alpha 先压白底再判，否则透明区会被当成纯黑
            # （这个坑本次已经踩过两次，见 providers.image._flatten_alpha）
            if im.mode in ("RGBA", "LA", "P"):
                rgba = im.convert("RGBA")
                bg = Image.new("RGB", rgba.size, (255, 255, 255))
                bg.paste(rgba, mask=rgba.getchannel("A"))
                im = bg
            else:
                im = im.convert("RGB")
            a = np.asarray(im).astype(np.float32)
    except Exception:      # noqa: BLE001 打不开就只报这一条，不猜原因
        return ["unreadable"]

    out: list[str] = []
    g = a.mean(axis=2)
    if float(g.std()) < _BLANK_SD:
        out.append("blank")
        return out            # 全白/全黑时后面几条判据没有意义

    if is_character:
        k = max(1, int(h * 0.06))
        border = np.concatenate([g[:k].ravel(), g[-k:].ravel(),
                                 g[:, :k].ravel(), g[:, -k:].ravel()])
        if float(np.median(border)) < _WHITE_MIN:
            out.append("bg_not_white")

    if want_size:
        try:
            ww, hh = (int(x) for x in want_size.lower().split("x"))
            if ww and hh and abs((w / h) - (ww / hh)) / (ww / hh) > _ASPECT_TOL:
                out.append("aspect_mismatch")
        except Exception:      # noqa: BLE001 size 串不规范就不判这条
            pass
    return out


#: 缺陷代码 → 给人看的说明。日志里直接写中文，用户不必查表。
LABELS = {
    "unreadable": "图片文件损坏或打不开",
    "blank": "画面近乎单色（多半是生成失败）",
    "bg_not_white": "角色定妆图的背景不是纯白（会把灰底带进每一个镜头）",
    "aspect_mismatch": "返回画幅与请求不符",
}


def report(name: str, path, *, is_character: bool,
           want_size: str | None = None) -> list[str]:
    """体检并**只记日志**。返回缺陷代码，调用方可忽略。

    ⚠️ 不改变出图行为、不重试、不阻断 —— 见模块头的说明。
    """
    try:
        bad = inspect(path, is_character=is_character, want_size=want_size)
    except Exception:      # noqa: BLE001 体检自身出错绝不能连累出图
        return []
    if bad:
        log.warning("[asset_qc] 「%s」体检发现问题：%s", name,
                    "；".join(LABELS.get(c, c) for c in bad))
    return bad
