"""镜头时长与锚点重排：**跨域共享的地基**，不依赖任何路由模块。

## 为什么单独成模块

这些函数原先住在 `routes_v2.py`（路由文件）里，于是**任务层想用得反过来
import 路由模块** —— `jobs.py` 里那两处函数内局部 import
（`from .routes_v2 import shot_seconds_cap, ...`）就是这么被迫写出来的，
而局部 import 绕循环正是 `verify-architecture.ts` 里 P2.2 记的那笔债。

它们的真实依赖只有 `providers.registry` / `script_import` / `db`，
**没有一条依赖路由**，所以正确的位置是这里：路由、任务、子模块
（`routers/audio.py` 等）都能直接拿，循环消失。

⚠️ 本文件里的函数体是**逐字**从 routes_v2.py 搬来的（AST 取源，未经手改），
搬迁本身不改变任何行为。

## 这一层管什么

- `RESOLUTION_TIERS` / `shot_seconds_cap` —— 单镜时长上限的**唯一**来源
- `narration_max_chars` —— 解说剧的字数口径（与秒数口径是同一个问题的两面）
- `_remap_anchors` / `_renumber` —— 镜头 order 变了以后，锚在 order 上的
  音频/字幕必须同步搬迁
- `_DurWindow` / `_narration_duration` —— 拆解合并参数与解说剧时长初值
- `_clamp_anchor` —— 把锚点镜号钳进实际存在的区间
"""
from __future__ import annotations

import logging
import math
from typing import NamedTuple

from sqlalchemy import func

from .db import Shot, get_session, profile_of
from .providers.registry import registry

logger = logging.getLogger(__name__)


RESOLUTION_TIERS: dict[str, float] = {
    "480p": 0.4, "720p": 0.9, "1080p": 2.0, "2k": 3.5,
}


def shot_seconds_cap(profile: dict | None) -> tuple[float, float | None]:
    """项目档案 → (单镜时长上限秒, 分辨率MP)。拆镜与回写时长的**唯一**来源。

    上限**由项目选定的视频模型自己说了算**，因为不同模型的约束根本不同：
      · RunningHub H3 —— 受我们这边的显存 MP·s 预算约束，**随分辨率变化**：
        0.5MP 能出 40s、2.0MP 只有 8s。
      · seedance —— 厂商侧硬钳 1~15s，与分辨率无关。
      · veo —— 固定只出 8s。

    ⚠️ 不能把 H3 的显存包线套到 seedance/veo 上：那是 RunningHub 的
    GPU 约束，跟火山/网关通道毫无关系。套上去会让 1080p 的 seedance 被
    误砍到 7.5s（它实际能出 15s），白白多切一倍镜头。

    超上限不会报错，这是危险之处：seedance 静默钳到 15s，而旁白音频仍是
    完整长度 —— 画面早停、声音还在响，用户看到"对不上"却查不出原因。

    模型未知/未指定（老项目档案）时退回按分辨率算的 H3 包线——
    H3 是默认视频模型，这个兜底与实际最可能用的通道一致。
    """
    from .script_import import max_narration_sec, with_headroom
    prof = profile or {}
    mp = RESOLUTION_TIERS.get(str(prof.get("resolution") or "").lower())

    model = str(prof.get("video_model") or "").strip()
    if model:
        p = registry.get_video(model)
        if p is not None:
            raw = p.max_seconds(mp)
            if raw and raw > 0:
                return with_headroom(raw), mp
    return max_narration_sec(mp), mp


def narration_max_chars(proj, video_model: str | None = None) -> int | None:
    """解说剧单镜 `script_ref` 的字数上限；非解说剧返回 None（不设限）。

    解说剧的镜头时长 = 旁白朗读时长，而旁白能读多久由视频模型的上限决定
    （720p 海螺 H3 只有 19.1s）。拆镜提示词按"7-15 秒视频"设计，一镜拆出
    116 字要读 26 秒——**读不完**，声音会盖到下一镜上。所以解说剧必须把这个
    字数上限带进拆解，让镜头一开始就切得足够细。

    字数用**最慢**语速反推（见 `_CHARS_PER_SEC_SLOW`）：算上限时假设读得慢，
    最坏情况刚好贴线；用均值反推会让慢段超出包线。

    `video_model`：一键成片会显式指定本次要用的视频模型，可能与项目档案里
    存的不同；给了就以它为准，否则用档案里的。
    """
    if (getattr(proj, "production_mode", None) or "") != "narration":
        return None
    from .script_import import _CHARS_PER_SEC_SLOW
    prof = dict(profile_of(proj))
    if video_model:
        prof["video_model"] = video_model
    cap, _mp = shot_seconds_cap(prof)
    # 兜底下限 20 字：再紧的上限也不该把镜头切成没法看的碎句；
    # 真出现这种档案（超高分辨率）说明该项目本就不适合做解说剧。
    return max(20, int(cap * _CHARS_PER_SEC_SLOW))


_SHOT_DUR_CEIL_FALLBACK = 15.0


def breakdown_shot_cap(proj, video_model: str | None = None) -> float | None:
    """真人剧拆镜时「一个镜头最长能多少秒」；拿不到模型信息返回 None（用历史窗口）。

    与 `narration_max_chars` 是**同一个问题的两种口径**：
      · 解说剧的镜头长度由旁白读多久决定 → 把上限换算成字数（那个函数）
      · 真人剧没有旁白，镜头长度就是下发给视频模型的时长 → 直接用秒数（本函数）
    两边都必须问模型要上限，因为它们的答案差了一倍：seedance-2.0 是 15s，
    2.5 是 30s。以前真人剧这条路径**根本没问**，写死 7-15 秒，于是选了 2.5 的
    项目照样被拆成 8-12 秒一镜——2.5 唯一的优势（单镜 30s 长镜）被拆解阶段扔掉了。

    ⚠️ 这里**不扣** `with_headroom` 的 2 秒安全余量。那 2 秒是给 TTS 语速波动留的
    （旁白比预估读得慢就会越过显存包线），真人剧没有旁白这个变量；时长是直接
    下发给视频模型的参数，贴着厂商硬钳走是安全的（超了才会被静默钳掉）。

    ⚠️ 只认**厂商硬钳**（`max_seconds(None)`：与分辨率无关的固定上限），
    不认 H3 那种**随分辨率变的显存包线**（它 `max_seconds(None)` 返回 None）。
    两者性质不同：前者是"这个模型天生就能一镜出这么长"，是创作口径；
    后者是"我们这台机器在这个分辨率下扛得住多久"，是资源口径。
    拿显存包线当创作目标会让 480p 的 H3 项目突然按 38-47 秒一镜去拆——
    那不是用户选分辨率时想要的，也没有任何实拍依据。

    `video_model`：一键成片会显式指定本次的视频模型，给了就以它为准。
    """
    if (getattr(proj, "production_mode", None) or "") == "narration":
        return None                     # 解说剧走 narration_max_chars，不用秒数口径
    prof = dict(profile_of(proj))
    if video_model:
        prof["video_model"] = video_model
    model = str(prof.get("video_model") or "").strip()
    if not model:
        return None
    p = registry.get_video(model)
    if p is None:
        return None
    raw = p.max_seconds(None)           # None = 只问厂商硬钳，不问显存包线
    return float(raw) if raw and raw > 0 else None


def shot_duration_ceiling(proj, model_id: str | None = None,
                          resolution: str | None = None) -> float:
    """时间轴上单个镜头**允许被设成**的最长秒数。

    必须跟着项目选定的视频模型走，不能写死 15：
      · seedance-2.5 一镜 30s —— 写死 15 的话，拆解好好地给出 28s 的长镜，
        用户在时间轴上随手拖一下裁剪手柄，这一镜就被砍成 15s。用户看到的是
        "我明明只想微调，它自己少了一半"，且没有任何提示。
      · 解说剧的 H3 在 0.5MP 下能出 38s（时长由 TTS 实测长度回写），
        同样会被 15 的钳制截断，画面早停而旁白还在响。
    拿不到模型/档案（老项目）时退回 15，与本改动之前一致。

    只**放宽**、绝不收紧：结果永远 ≥15。H3 在 1080p 下的显存包线只有 9.5s，
    直接拿它当上限会让存量项目里已经存在的 15s 镜头再也调不回去——
    那是个体验倒退，且与"本次只为 2.5 松绑"的目标无关。

    ## ⚠️ 镜头级模型覆盖（2026-10-20）

    镜头可以**单独换模型**（`profile_override.model_id`），出片时以它为准。
    此前本函数只看项目档案里的模型：项目用 2.0 建（上限 15）、某一镜改成 2.5
    （能出 30s），界面上那镜的时长下拉仍被砍到 15，拖到 20s 保存时还会被这里
    悄悄钳回 15 —— 用户看到的是"我选了 2.5，可它还是只能 15 秒"。
    `model_id` / `resolution` 传镜头级覆盖值即以它为准；不传 = 老行为（项目口径）。
    """
    cap = None
    prof = dict(profile_of(proj) or {})
    if model_id:
        prof["video_model"] = model_id
    if resolution:
        prof["resolution"] = resolution
    model = str(prof.get("video_model") or "").strip()
    if model:
        p = registry.get_video(model)
        if p is not None:
            mp = RESOLUTION_TIERS.get(str(prof.get("resolution") or "").lower())
            raw = p.max_seconds(mp)
            if raw and raw > 0:
                cap = float(raw)
    return max(_SHOT_DUR_CEIL_FALLBACK, cap) if cap else _SHOT_DUR_CEIL_FALLBACK


#: 变速的合理范围。**唯一来源** —— 前端、擦字幕、字幕定时、剪映导出都读这一对常量。
#:
#: ## 这不是平台限制（2026-10-24 更正）
#:
#: 上一版这里写的是「0.25~4 是剪映草稿自己认的范围，超过它剪映会把 speed 字段
#: 判成非法」。**那是编的** —— 实测 `pyJianYingDraft` 构造 `speed=10.0` 不报错，
#: 导出的 JSON 里就是 10.0，没有任何校验。所以 0.25~4 只是我凭印象设的，
#: 却写成了"平台不让你超"。这种假依据会把一个可以商量的默认值伪装成硬约束，
#: 谁看了都不敢动它 —— 比没有依据更糟。
#:
#: 真正的物理约束只有两条：
#:   · 必须 > 0（下游处处要除以它）；
#:   · 太极端会变成逐帧抽帧/逐帧重复，画面失去意义。
#: 所以这里放宽到 [0.1, 10]，性质是**防手滑的边界**，不是"只准这么快"。
#: 要更极端的速度先问用户，别自己把范围改回去。
SPEED_MIN = 0.1
SPEED_MAX = 10.0


def clamp_speed(v) -> float:
    """把任意输入钳成**能安全参与计算**的播放速度。

    非数字 / None / 0 一律回 1.0（不报错）：速度是个装饰性参数，为它让整次
    导出失败是不划算的 —— 但**不能**回 0，0 会让下游的除法炸掉。
    """
    try:
        x = float(v)
    except (TypeError, ValueError):
        return 1.0
    if not (x > 0):          # NaN 也走这里
        return 1.0
    return max(SPEED_MIN, min(SPEED_MAX, x))


def shot_speed(shot) -> float:
    """这一镜的播放速度（1.0 = 原速）。读 `transform_meta.speed`。

    三条链路必须给同一个数：剪映导出（`routers/jianying.py`）、字幕定时
    （`routers/subtitle.effective_shot_sec`）、擦字幕的源/输出秒换算
    （`desub_jobs`）。它们此前各写了一份 `max(0.25, min(4.0, …))`，
    而导出那一份**压根不存在**（0 次出现）—— 用户在前端设的变速从来没进过
    剪映草稿。现在统一到这里。
    """
    import json as _json
    raw = getattr(shot, "transform_meta", None)
    if not raw:
        return 1.0
    if isinstance(raw, str):
        try:
            raw = _json.loads(raw)
        except (ValueError, TypeError):
            return 1.0
    if not isinstance(raw, dict):
        return 1.0
    return clamp_speed(raw.get("speed") or 1.0)


def shot_source_window(shot, file_dur: float | None = None) -> tuple[float, float]:
    """这一镜在**源文件**里取用的那一段 → `(入点秒, 时长秒)`。

    `clip_dur_sec` 优先于 `duration_sec`（分割后的窗口），都没有时按调用方
    给的整条时长；给不出就是 5 秒兜底 —— 返回长度 0 会让后面的片段全部
    叠在同一时刻上。

    ⚠️ 这是**源**窗口，不是时间轴占用。要算"在成片里占多久"用
    `shot_output_sec`：两者差一个 speed 倍数。
    """
    base = getattr(shot, "clip_dur_sec", None) or getattr(shot, "duration_sec", None)
    dur = float(base or 0) or 5.0
    cin = max(0.0, float(getattr(shot, "clip_in_sec", None) or 0.0))
    if file_dur and file_dur > 0:
        # 源文件比窗口短时以文件为准：剪映会拒绝越界的入出点（直接抛 ValueError）。
        dur = min(dur, max(0.05, float(file_dur) - cin))
    return cin, dur


def shot_output_sec(shot, file_dur: float | None = None) -> float:
    """这一镜在**成片里**占多少秒 = 源窗口时长 / 速度。

    这是字幕时间码、音效锚点、整集时长统计的**唯一**口径。
    """
    _cin, dur = shot_source_window(shot, file_dur)
    return dur / shot_speed(shot)


def subtitle_output_span(shot, offset_sec, dur_sec) -> tuple[float, float]:
    """字幕的 `(镜内偏移, 显示时长)`：**源秒 → 成片秒**。

    ## 为什么必须是这个函数（2026-10-24 用户报障）

    用户反馈「1023 新导出的字幕时间位置全错了」。

    根因：字幕的 `start_offset_sec` / `duration` 是按**源帧**记的 —— ASR 转写的
    是镜头视频文件本身（`_extract_asr_audio` 剥的是完整音轨，不认 `clip_in_sec`），
    所以偏移天然是"这个文件里的第几秒"。而导出写进剪映草稿的是**输出时间轴**，
    1.7 倍速下源第 4.06 秒其实落在成片第 2.39 秒。两边差一个 speed 倍数，
    而且越往后错得越多（同一个镜头里的第 5 条字幕能偏出两三秒）。

    实测 1023：29 条字幕里 **17 条**的 `offset + duration` 超过了本镜的成片时长 ——
    这在物理上不可能。按 speed 换算后 **0 条越界**。这个判据（"字幕不能比镜头
    自己还长"）就是这里最硬的证据，也是 `speech_rate._anchor_check` 用的同一条。

    ⚠️ 不要顺手把 `clip_in_sec` 也减掉：字幕偏移是**相对取片窗口**的，不是相对
    整个源文件。反证在 `7fd29f5231bf` 的 shot 8 —— `clip_in=12.12`、
    `clip_dur=5.93`，而它的字幕跨度正好是 `0 → 5.93`。减掉 clip_in 会让整条轨
    往负数跑。ASR 那边之所以能这样，是因为它本来就把整个文件当成这一镜的内容；
    取片窗口只影响导出时的入点，不影响口型对齐。
    """
    spd = shot_speed(shot)
    return (float(offset_sec or 0.0) / spd,
            float(dur_sec or 0.0) / spd)


def subtitle_source_span(shot, start_sec, end_sec) -> tuple[float, float] | None:
    """`time_base='source'` 字幕的 `(镜内偏移, 显示时长)`：**源文件秒 → 成片秒**；落在取片窗口外返回 None。

    这种字幕（Muse 逐字字幕，2026-11-21）的起止是这一镜**源文件**里的秒：转写的是整个文件，
    不减取片入点、不除变速。导出时先截到取片窗口 `[入点, 入点+时长)` 里，再减入点、除速度：
    修剪掉的那段话不出字幕，入点后移不会让字幕整体错位。与老口径 `subtitle_output_span`
    （偏移相对取片窗口，见那里的说明）是两种数据，按 `SubtitleClip.time_base` 选用，不能混。
    """
    cin, dur = shot_source_window(shot)
    spd = shot_speed(shot)
    a = max(float(start_sec or 0.0), cin)
    b = min(float(end_sec or 0.0), cin + dur)
    if b <= a:
        return None
    return (a - cin) / spd, (b - a) / spd


def episode_total_sec(shots) -> float:
    """一批镜头在成片里的总时长（秒）。**停用/没出片的不算**。

    与导出、字幕、`episode_clips` 同一个口径：这四处此前各算各的 ——
    `episode_clips` 用 `clip_dur_sec ?? duration_sec` 但**不除速度**，
    导出的时间轴除速度，字幕也除速度。于是页面显示的整集时长比实际成片长，
    而且只在有变速的项目里对不上（用户会觉得"这集明明 6 分钟，怎么导出 5 分 20"）。
    """
    total = 0.0
    for sh in shots or []:
        if getattr(sh, "disabled", 0):
            continue
        total += shot_output_sec(sh)
    return round(total, 3)


def shot_override_ceiling(session, shot) -> float:
    """某一镜**实际生效**的时长上限：镜头覆盖的模型/档位优先，其余用项目口径。

    出片链路选模型就是 `override.model_id or 项目档案`（见 jobs 的
    `model_id = override.get("model_id") or default_model`），本函数与它同口径。
    """
    import json as _json

    from .db import Project
    ov: dict = {}
    try:
        ov = _json.loads(shot.profile_override) if shot.profile_override else {}
        if not isinstance(ov, dict):
            ov = {}
    except (ValueError, TypeError):
        ov = {}
    return shot_duration_ceiling(
        session.get(Project, shot.project_id),
        model_id=(ov.get("model_id") or None),
        resolution=(ov.get("resolution") or None))


def _remap_anchors(session, project_id: str, mapping: dict[int, int]) -> int:
    """把音频/字幕的锚点 order 按 mapping 搬迁。返回搬动的行数。

    ⚠️ 为什么必须做：AudioClip.start_shot_order / SubtitleClip.start_shot_order
    是**普通整数**，不是外键。重编号只改 Shot.order，这些锚点原地不动，
    结果就是分割镜头、插入片头、调序、增量拆解之后，
    所有挂在后面的旁白与字幕**整体错位到别的镜头上**，且没有任何提示。
    （超出新末尾的锚点还会在 SRT 导出时被静默跳过。）

    mapping: 旧 order → 新 order。没列出的 order 保持不动。
    """
    if not mapping:
        return 0
    from .db import AudioClip, SubtitleClip
    moved = 0
    for model in (AudioClip, SubtitleClip):
        rows = (session.query(model)
                .filter(model.project_id == project_id).all())
        for r in rows:
            new = mapping.get(r.start_shot_order)
            if new is not None and new != r.start_shot_order:
                r.start_shot_order = new
                moved += 1
    if moved:
        logger.info("[renumber %s] 同步搬迁 %d 条音频/字幕锚点", project_id, moved)
    return moved


def snapshot_anchors(session, project_id: str) -> dict[int, str]:
    """记录「锚点镜号 → 它此刻指向的镜头 id」。

    ⚠️ **必须在改动任何 `Shot.order` 之前调用**。

    为什么需要它：`AudioClip.start_shot_order` / `SubtitleClip.start_shot_order`
    是**普通整数**，不是外键。一旦 order 变了，光看数字已经无从知道它原本
    指向哪一镜 —— 而"给后面的镜头让位"（先手动 +1、再 `_renumber`）这条路径
    恰好让数字彻底失去意义：手动 +1 之后序列**已经是 1..N 连续**，
    `_renumber` 反推出的 mapping 恒为空，`_remap_anchors` 直接 return 0。

    后果（2026-10-08 修）：分割一镜 / 插入片头 / 调序之后，被编辑镜之后的
    所有旁白与字幕**整体挂到别的镜头上** —— 成片里 A 镜的画面配 B 镜的台词
    （剪映草稿与 SRT 都按这个锚点排序），全链路无任何报错。

    记住**身份**而不是数字，是唯一与"调用方怎么挪 order"无关的判据。
    """
    live = {s.order: s.id for s in
            session.query(Shot).filter(Shot.project_id == project_id).all()}
    from .db import AudioClip, SubtitleClip
    snap: dict[int, str] = {}
    for model in (AudioClip, SubtitleClip):
        for r in session.query(model).filter(model.project_id == project_id).all():
            sid = live.get(r.start_shot_order)
            if sid:
                snap[r.start_shot_order] = sid
    return snap


def remap_anchors_by_identity(session, project_id: str,
                              snap: dict[int, str]) -> int:
    """按快照把锚点搬回**它原本指向的那一镜**（与新旧编号无关）。返回搬动行数。

    与 `_remap_anchors`（按数字映射搬）并存：那个适用于"order 变了、但
    新旧数字的对应关系是确定的"场景；本函数适用于"数字已经被手动改过、
    对应关系不可反推"的插入/分割路径。两条都要过 `_clamp_anchor` 的
    边界约束（调用方负责），这里只负责指向正确。
    """
    if not snap:
        return 0
    now = {s.id: s.order for s in
           session.query(Shot).filter(Shot.project_id == project_id).all()}
    from .db import AudioClip, SubtitleClip
    moved = 0
    for model in (AudioClip, SubtitleClip):
        rows = (session.query(model)
                .filter(model.project_id == project_id).all())
        for r in rows:
            target = snap.get(r.start_shot_order)
            if not target:
                continue                      # 原本就没锚在任何镜头上的，不动
            new = now.get(target)
            if new is not None and new != r.start_shot_order:
                r.start_shot_order = new
                moved += 1
    if moved:
        logger.info("[renumber %s] 按身份回填 %d 条音频/字幕锚点", project_id, moved)
    return moved


# ---------------------------------------------------------------------------
# 造型阶段的镜号区间：与音频/字幕锚点是**同一类锚点**，必须一起搬
# ---------------------------------------------------------------------------
#
# ⚠️ 2026-10-22（生产事故类）：`AssetStage.shot_from/shot_to` 存的同样是
# `Shot.order` 这一列，但它一直**没有**被纳入重编号搬迁 —— `_renumber` 只搬
# `AudioClip` / `SubtitleClip` 的 `start_shot_order`，造型区间原地不动。
#
# 后果与锚点错位同源、但更隐蔽：一套「只在这 3 镜换装」的造型，重排之后可能
# 挪到别的集上（实测生产 `faa6074325ce` 有 12 条整条落到别的集，`ep22 声明、
# 应存 60..63、实际存 48..48`），于是它**永远不生效**，而界面只显示区间、
# 不显示结果，用户只能得出「造型设了没用」这个结论。
#
# 判据与锚点完全一致：**记身份（shot_id 集合）而不是数字**。
# 区间内镜头的集合在重排前后是同一批 id，按新 order 重算 min/max 就是正确区间；
# 这也顺带覆盖了「区间中间插入/删除了镜头」——集合会自动变小，不会把新镜头
# 卷进来。

def snapshot_stage_ranges(session, project_id: str) -> dict[str, list[str]]:
    """记录「造型阶段 id → 它此刻覆盖的 shot_id 列表」。

    ⚠️ **必须在改动任何 `Shot.order` 之前调用**（与 `snapshot_anchors` 同一条）。

    只对有镜号区间的阶段取快照：没有区间的（整集生效 / 场景绑定）不依赖 order，
    不需要搬，也不该被搬。返回空 dict 时下游直接跳过，零开销。
    """
    from .db import AssetStage, Shot
    stages = (session.query(AssetStage)
              .filter(AssetStage.project_id == project_id,
                      AssetStage.shot_from.isnot(None) | AssetStage.shot_to.isnot(None))
              .all())
    if not stages:
        return {}
    order_of = {s.order: s.id for s in
                session.query(Shot).filter(Shot.project_id == project_id).all()}
    snap: dict[str, list[str]] = {}
    for st in stages:
        lo = st.shot_from if st.shot_from is not None else -(10 ** 9)
        hi = st.shot_to if st.shot_to is not None else 10 ** 9
        ids = [sid for o, sid in order_of.items() if lo <= o <= hi]
        if ids:
            snap[st.id] = ids
    return snap


def remap_stage_ranges_by_identity(session, project_id: str,
                                   snap: dict[str, list[str]]) -> int:
    """按快照把造型区间搬回**它原本覆盖的那批镜头**。返回改动的阶段数。

    - 集合里还有镜头 → 按它们的新 order 取 min/max 写回（开区间保持开区间语义：
      原本 `shot_to is None` 的仍然是 None，只是下界随集合移动）
    - 集合里的镜头**全被删了** → 不猜，保持原值并记 warning。把区间清空成
      「整集生效」等于让这套造型突然覆盖一整集，比原样留着更危险。
    """
    if not snap:
        return 0
    from .db import AssetStage
    now = {s.id: s.order for s in
           session.query(Shot).filter(Shot.project_id == project_id).all()}
    moved = 0
    for st_id, ids in snap.items():
        st = session.get(AssetStage, st_id)
        if st is None or st.deleted_at:
            continue
        orders = [now[i] for i in ids if i in now]
        if not orders:
            logger.warning(
                "[renumber %s] 造型「%s」原覆盖的 %d 镜全被删除，区间保持不动",
                project_id, st.stage_name, len(ids))
            continue
        lo, hi = min(orders), max(orders)
        new_from = None if st.shot_from is None else lo
        new_to = None if st.shot_to is None else hi
        # 拖拽调序可能把区间**中间**的某一镜拖到很远，这时这批镜头已不再连续：
        # 一个闭区间表达不了它们，min..max 会把中间那些镜头一起框进来。
        # 这不是能自动决定的事（是拆成两套造型，还是放弃这次搬迁？），
        # 所以按"宁可多覆盖也不丢造型"处理，但**必须留痕**——否则就是
        # 「区间怎么突然大了」这类无从查起的问题。
        span = hi - lo + 1
        if span != len(set(orders)):
            logger.warning(
                "[renumber %s] 造型「%s」原覆盖的 %d 镜已被拖散（新编号 %s），"
                "用闭区间 #%s–#%s 表达会多覆盖 %d 镜；如需精确控制请到造型面板拆成两套",
                project_id, st.stage_name, len(set(orders)),
                sorted(set(orders)), lo, hi, span - len(set(orders)))
        if (new_from, new_to) != (st.shot_from, st.shot_to):
            logger.info("[renumber %s] 造型「%s」区间 %s..%s → %s..%s",
                        project_id, st.stage_name, st.shot_from, st.shot_to,
                        new_from, new_to)
            st.shot_from, st.shot_to = new_from, new_to
            moved += 1
    return moved


def _renumber(session, project_id: str) -> None:
    """把 order 规整为 1..N 连续整数（插入/移动后调用），并同步搬迁锚点。

    ⚠️ 插入/分割/调序的路径上，**只有这个函数是不够的**：那些调用方会先
    手动给镜头让位（`s.order += 1`），使序列提前变成连续的 1..N，
    于是这里的 mapping 反推为空、锚点纹丝不动。那类调用方必须在外层配一对
    `snapshot_anchors` / `remap_anchors_by_identity`（见两函数说明）。
    **造型阶段同理**：那条路径要再配 `snapshot_stage_ranges` /
    `remap_stage_ranges_by_identity`（2026-10-22）。

    纯删除路径（`session.delete` 之后调用）没有手动让位，这里就够用 ——
    造型区间在这一条路里由下面的 `_remap_stage_ranges_by_mapping` 覆盖。
    """
    shots = (session.query(Shot).filter(Shot.project_id == project_id)
             .order_by(Shot.order).all())
    mapping: dict[int, int] = {}
    for i, s in enumerate(shots, start=1):
        if s.order != i:
            mapping[s.order] = i
            s.order = i
    # 与重编号同一事务：分开提交的话，中间崩溃会留下错位的锚点
    _remap_anchors(session, project_id, mapping)
    # 造型区间的**按数字映射**版本：只在"纯删除/纯规整"这条路上有意义。
    # 插入/分割/调序那几条路 mapping 恒为空（调用方先手动让位了），
    # 必须用外层的 snapshot/remap_by_identity 那一对。
    _remap_stage_ranges_by_mapping(session, project_id, mapping)


def _remap_stage_ranges_by_mapping(session, project_id: str,
                                   mapping: dict[int, int]) -> int:
    """按 order 映射搬造型区间。`mapping` 为空时直接返回（绝大多数情况）。

    `mapping` 是「旧 order → 新 order」，由 `_renumber` 在**重编号之后**反推，
    所以它只覆盖"真的动了"的那些 order，且天然单调（重编号是压缩成 1..N）。

    ⚠️ 只搬两个端点，不去算区间内部。理由：order 单调，端点搬对之后区间
    覆盖的镜头集合自然是对的；反过来"取区间内所有映射值再求 min/max"在
    "区间尾部的镜头被删、而头部没动"时会**把尾巴往回拉**，凭空多覆盖几镜。
    端点不在 mapping 里 = 那一镜没动，保持原编号（不能当成"没了"）。
    """
    if not mapping:
        return 0
    from .db import AssetStage
    sts = (session.query(AssetStage)
           .filter(AssetStage.project_id == project_id,
                   AssetStage.deleted_at.is_(None),
                   AssetStage.shot_from.isnot(None) | AssetStage.shot_to.isnot(None))
           .all())
    moved = 0
    for st in sts:
        lo, hi = st.shot_from, st.shot_to
        nlo = mapping.get(lo, lo) if lo is not None else None
        nhi = mapping.get(hi, hi) if hi is not None else None
        if (nlo, nhi) != (lo, hi):
            st.shot_from, st.shot_to = nlo, nhi
            moved += 1
    if moved:
        logger.info("[renumber %s] 按映射搬迁 %d 条造型区间", project_id, moved)
    return moved


def _clamp_anchor(session, project_id: str, order) -> int:
    """把锚点镜号钳进项目**实际存在**的镜号区间（音频段/字幕段共用）。

    原来四处都只写 `max(1, order)` —— 只钳下界，没有上界。于是把字幕/音频锚到
    一个不存在的镜号（前端算错、拆解后镜头变少、或直接调 API 传了 99）时，
    值会被静默存下来，而导出走的是"按镜头顺序累加时长"得到的 offsets 表：
        base = offsets.get(c.start_shot_order)   # → None
        if base is None: continue                # → 整段被跳过
    结果这段音频/字幕**永远不会出现在成片里**，前端时间轴上也没有它的落点，
    用户只看到"字幕丢了"，没有任何报错可循（B18）。

    钳到最后一镜比静默丢弃诚实：用户至少能在时间轴上看见它、再拖到想要的位置。
    注意 bounds 不过滤 disabled —— 锚在停用镜头上是可恢复的（重新启用就回来），
    不该借这次钳位把它挪走。
    """
    o = max(1, int(order or 1))
    lo, hi = (session.query(func.min(Shot.order), func.max(Shot.order))
              .filter(Shot.project_id == project_id).one())
    if lo is None:        # 项目还没拆镜，无从判断上界；留原值，拆完由重编号修正
        return o
    return min(max(o, int(lo)), int(hi))


#: 拿不到模型信息时，`recut` 中间段（B 段）的兜底下限。
#: 4s 是 seedance 系列的真实下限，也是本改动之前时间轴默认的单镜最短口径。
#: 与上面的上限兜底同一个理由：宁可放行后由 provider 明确报错，
#: 也别拿凭空的数字把用户正常的划线拦下来。
_RECUT_MIN_FALLBACK = 4.0


#: 拆解合并窗口的四个端点（秒）。`_DurWindow` 的组成部分，
#: 同时也是 `_raw_duration` / `_merge_short_shots` 的兜底口径。
_DUR_FLOOR = 7.0
_DUR_SWEET_LO = 8.0
_DUR_SWEET_HI = 12.0
_DUR_CEIL = 15.0


class _DurWindow(NamedTuple):
    """一次拆解的镜头**合并**参数。由项目选定的视频模型决定。

    ⚠️ 它只管「几个节拍能并成一镜」，**不管「一个节拍值多少秒」**。
    秒数永远由内容决定（LLM 按 4 字/秒等规则估、`_raw_duration` 兜底），
    与用哪个模型无关：同一集剧本换个模型不会突然多出 30 秒剧情。

    这个边界是踩坑踩出来的。最初的写法是把 [25,30] 当"目标区间"写进提示词，
    结果 LLM 直接照着区间填数字：1870 字的一集，8-12 秒窗口下报 90 秒、
    25-30 秒窗口下报 120 秒，而两次的 script_ref 文字量几乎相同——
    多出来的 30 秒是注水的慢镜。**给 LLM 什么区间它就填什么区间**，
    那是锚定不是估计，所以现在提示词对所有模型完全一致。

    - `floor`  合并判定阈值：短于它的镜头就尝试并进邻镜
    - `ceil`   模型单镜硬上限：合并后不得越过它，最终时长也钳在它以内
    """
    floor: float
    ceil: float


_DUR_WINDOW_DEFAULT = _DurWindow(_DUR_FLOOR, _DUR_CEIL)


def action_window(win: _DurWindow) -> _DurWindow:
    """高强度动作镜专用的合并/拆分窗口：**不参与长镜打包**。

    ## 为什么动作镜必须单独一套窗口（2026-09-23）

    `_dur_window` 对长镜模型（seedance-2.5，cap 30s）令 `floor = ceil`，
    意思是「只要相邻两镜加起来装得下就并」，一路打包到 30 秒。
    对文戏这是长镜能力的正确用法：一场对话从 3 刀变 1 刀，AI 只想象一次那扇门。

    **对武戏这正好是灾难**。项目 923 的 #1 就是这么来的 —— LLM 本来按提示词
    给的是 7-15 秒的镜头，合并阶段把它们一路打包成 **27.1 秒装八件事**
    （开团→划火花→对话→指挥→连续攻防→扛拳→连刺七剑）。一个镜头只能生成
    一段连续动作，装八件事的结果就是模型退回"六张不同景别的静态构图"。

    实测佐证（`scripts/verify_action_rule_e2e.py`）：挂上 `动作强度=高` 标记后，
    单事件动作镜（#4/#6/#18）的时间片 4/4/5 **全部归零**，唯独这个多事件长镜
    #1 反而从 0 段被切成 3 段 —— 内容装不下时，提示词规则只能把模型逼去
    "组织结构"。**提示词层治不了容量问题，必须在切镜这一层治。**

    ## 为什么是「取 min」而不是写死 [7,15]

    窗口只能收紧、不能放宽：海螺 H3 在 1080p 下 cap 只有 7.5 秒，
    给它一个 ceil=15 的动作窗口会让镜头超出厂商硬钳，被静默截断。

    ## 边界：只有 `high` 走这里

    `light`（推门、奔跑、跌倒、拥抱）**不走**这条路径，仍用原窗口。
    那恰恰是拆解提示词第 6 条要保护的一类（「开门/上下车/递交物品必须同一镜，
    否则前一镜木门后一镜玻璃门」）。把 light 也收紧等于拿文戏的稳定性
    去换武戏的收益，而 light 本来就没有"装不下"的问题。
    """
    d = _DUR_WINDOW_DEFAULT
    return _DurWindow(min(win.floor, d.floor), min(win.ceil, d.ceil))


def _narration_duration(ref: str, cap_sec: float) -> float:
    """解说剧的镜头时长初值：**按旁白朗读时长**，而不是甜点区间 [7,15]。

    解说剧的画面是给旁白配的，镜头该多长完全由"这段文字读多久"决定
    （见 jobs._retime_shot：TTS 出来后还会用真实时长再覆盖一次）。
    用 [7,15] 钳会有两种错法：480p 能出 45s 长镜却被砍成 15s（旁白大段盖到
    下一镜），1080p 只能出 7.5s 却下发 15s（模型静默截断，画面早停声音还在响）。

    这里只负责"首次出片时的目标时长合理"，最终仍以 TTS 实测时长为准。
    """
    from .script_import import estimate_tts_seconds
    sec = estimate_tts_seconds(ref) + 0.4      # 与 _retime_shot 同样留 0.4s 尾巴
    return round(max(2.0, min(cap_sec, sec)), 1)


#: 镜内分段的**下限**判据（2026-10-11 改）。
#:
#: ⚠️ **这里不再有"每段约 N 秒"这种除数。** 那是被实测否掉的算法。
#:
#: 旧实现是 `段数 = 时长 ÷ 2.8`，并把结果连**均长**一起下发
#: （「请切成约 9 段（每段约 2.9 秒）」）。实测后果：
#:   · 段数被精确兑现（26.5 秒 → 18 段，标准差 0.00）
#:   · 但**段长几乎完全均等**，错落度 0.07，而外部标杆是 0.396 —— 差 5 倍
#:   · n=5 重复实验证明：同一配置两次跑出「4 种段长」和「11 种段长」，
#:     说明调措辞改不动它，**均等是那个除法本身的结果**
#: 即：**把除数递给模型，它就会按除数均分。** 这正是外部生成师方案 §7
#: 点名要禁止的「总时长 ÷ 固定平均段长 = 段数」。
#:
#: 所以改成**只给下限**，理由与旧版完全相反：
#:   · 旧版的下限来自"目标密度"（2.8 秒/段）→ 会诱导均分
#:   · 新版的下限来自**反停滞**：任何一段都不得长于 `_SEG_HARD_MAX` 秒，
#:     所以一镜至少要有 `时长 ÷ _SEG_HARD_MAX` 个事件。
#: 这是**质量下限**，不是数量目标 —— 模型可以切得更碎，也可以按内容少切，
#: 只要没有一段长到让画面停滞。
_SEG_HARD_MAX = 4.0     # 单段硬上限：超过它就是"停在那里没变化"
_SEG_MIN = 3            # 极短镜的兜底下限


def segment_floor(duration_sec: float | None) -> int:
    """这一镜**至少要切几刀** —— 由「不许有一段长过 4 秒」反推，不给目标值。

    与旧 `segment_count()` 的关键差别：**它不返回目标，只返回下限**，
    且措辞里**不出现任何均长**（见 `_SEG_HARD_MAX` 的文档）。

    26.5 秒 → 下限 7 刀。实测（`calibrate_v3.py`）：
      · 旧版给「约 18 段（每段 1.5 秒）」→ 18 段，错落度 0.07
      · 只给判据不给数字（event 档）→ 11 ± 0.89 段，错落度 0.15
    下限 7 落在两者之间且**远低于旧目标**，给模型的自由度更大。
    """
    d = float(duration_sec or 0)
    if d <= 0:
        return _SEG_MIN
    return max(_SEG_MIN, int(math.ceil(d / _SEG_HARD_MAX)))


def render_duration_ctx(sec: float) -> str:
    """把「目标时长 + 分段下限 + 三档时长参考」渲染成喂给优化器的一段话。

    ⚠️ **必须只有一份**（2026-10-11）。这条约束在本项目里已经被违反过两次：
      · 拆解与提示词两处各写一套时长口径 → 产出劈叉
      · 提示词两条路径（`_pregen_prompts` 预生成 / `_build_prompt_ctx` 出片）
        各写一套段数口径 → 改了这处忘了那处

    2026-10-11 第二次改：段数从"目标值"改成"下限"，
    并**删掉了「每段约 N 秒」**（那是均等的来源），
    以及**删掉了「机位默认固定」**（出品硬规则已删除该口径，
    固定机位与轻量运动都是合法默认；在这里重复一句会把旧口径又带回来）。
    """
    floor = segment_floor(sec)
    return (
        f"目标时长: {sec:.2f} 秒\n"
        f"镜内分段: **按事件切，不按秒数切。** 一个事件一刀"
        f"（一次转头、一次递物、一句台词配一个反应、一处道具特写、一次权力关系变化）。\n"
        f"⚠️ **至少要 {floor} 刀** —— 这是**下限**，不是目标。"
        f"因为**任何一段都不得超过 4 秒**：超过就是画面停滞，观众会觉得卡住了。\n"
        f"⚠️ **不要平均分。** 段长要长短错落，三档都要有：\n"
        f"   · 极短反应 **0.6–1.0 秒**（一个转头、一次眼神变化）\n"
        f"   · 常规段 **1.0–2.2 秒**（一次递物、一句短台词配反应）\n"
        f"   · 完整台词／复杂动作 **2.5–4.0 秒**\n"
        f"   全都写成两秒是节拍器，不是剪辑。\n"
        f"⚠️ 人物动作与表演必须铺满这个时长，不要写只够三四秒的内容。"
    )

