"""流水线：拆解任务 nd_breakdown + 成片任务 nd_produce。

nd_produce 的顺序（每一步的输出是下一步的输入，用户不参与中间环节）：

  ① 旁白/画外音 TTS（全剧一个解说音色）→ 每句实长
  ② 按实长排时间窗；超 14.5s 的镜头按拍切开（Seedance 一镜最长 15s）
  ③ 写带时间窗的提示词（旁白段只演不说、台词段开口），出片
  ④ 对齐：有声片段 → 台词定位 → 剪辑单元 + 逐句核对
  ⑤ 核对不过（台词 <90% 或没念）→ 自动重出一次（扣积分，用户裁定），留更好的那版
  ⑥ 仍没念的台词 → TTS 补位（音色：角色资产音色 → 该角色在别的镜头里的原声 → 解说音色）

状态全在镜头 `profile_override["nd"]`；剪映草稿由 export.py 按其中的 units 写。
"""
from __future__ import annotations

import asyncio
import json
import logging
import math
import re
import uuid
from pathlib import Path

from ..db import Asset, Project, Shot, get_session
from . import DEFAULT_MODEL, H3, MODELS, WAN
from . import align as A
from . import breakdown as B
from . import textutil as T
from ..err_text import human_error

log = logging.getLogger(__name__)

SEG_MAX = 14.5        # Seedance / H3 一镜 ≤15s，留 0.5s 余量
WAN_SEG_MAX = 29.0    # 万相一镜 ≤30s
RETRY_RATIO = 0.9     # 台词一致度低于它就自动重出（单字句不判——ASR 噪声太大）
MAX_ATTEMPTS = 2      # 首出 + 自动重出一次


# ------------------------------------------------------------------ 状态读写

def nd_of(shot) -> dict:
    try:
        ov = json.loads(shot.profile_override or "{}")
    except (ValueError, TypeError):
        ov = {}
    return ov.get("nd") if isinstance(ov.get("nd"), dict) else {}


def save_nd(sid: str, nd: dict, **shot_fields) -> None:
    with get_session() as session:
        sh = session.get(Shot, sid)
        if not sh:
            return
        try:
            ov = json.loads(sh.profile_override or "{}")
        except (ValueError, TypeError):
            ov = {}
        if not isinstance(ov, dict):
            ov = {}
        ov["nd"] = nd
        sh.profile_override = json.dumps(ov, ensure_ascii=False)
        for k, v in shot_fields.items():
            setattr(sh, k, v)
        session.commit()


def _dur(url: str | None) -> float | None:
    """素材时长（秒）：优先读素材台账（不下载），台账没有再读本地文件。"""
    if not url or "/fw/media/" not in url:
        return None
    from ..media_cache import meta_of, probe_meta
    rel = url.split("/fw/media/", 1)[1]
    m = meta_of([rel]).get(rel) or {}
    if not m.get("duration_us"):
        from ..media import ensure_local
        p = ensure_local(url)
        if p is not None and p.is_file():
            m = probe_meta(p)
    us = m.get("duration_us")
    return us / 1e6 if us else None


def current_video(session, shot, take: dict | None) -> tuple[str | None, str]:
    """导出该用哪条视频：(url, 说明)。

    剪辑单元的入出点是相对**对齐时那条原片**（take.video_url）的。交付页的去字幕 /
    高清放大会生成新版本并换掉 shot.video_url；二者都保证逐帧等长，并在版本 meta 里
    记 `src_video_url` 与 `duration_drift`。所以：从当前视频顺着 src_video_url 往回追，
    能追到原片、且一路没有时长漂移 → 用当前视频（擦过字幕 / 高清过的）；
    否则（切到了另一次出片的版本、或处理时漂了）→ 退回原片，剪辑方案只对它成立。
    """
    from ..db import ShotVersion
    base = (take or {}).get("video_url")
    cur = shot.video_url
    if not base:
        return None, "没有出片"
    if not cur or cur == base:
        return base, ""
    url, steps = cur, []
    for _ in range(12):
        v = (session.query(ShotVersion).filter(ShotVersion.shot_id == shot.id,
                                               ShotVersion.video_url == url).first())
        if v is None:
            break
        try:
            m = json.loads(v.meta or "{}")
        except (ValueError, TypeError):
            m = {}
        drift = m.get("duration_drift")
        if drift not in (None, False, 0, 0.0):
            # 「漂移」标记不能直接信：高清放大按**容器总时长**判、容差 0.05s，而放大产物的
            # 音轨常比原片短几十毫秒（实测 12.096→12.042：画面同为 289 帧、音轨相关偏移 0、
            # 只是 AAC 尾巴短了 64ms）——时间点没动，剪辑方案照样对得上。
            # 所以按实际差多少判：≤0.15s 且处理版长度够覆盖剪辑方案用到的最后一刻，就照用。
            # 去字幕记的是具体秒数，直接用；放大只记「是/否」，要查实际时长。
            if isinstance(drift, (int, float)) and not isinstance(drift, bool):
                fine = abs(float(drift)) <= 0.15
            else:
                d_new, d_src = _dur(v.video_url), _dur(m.get("src_video_url"))
                need = max((u.get("e") or 0 for u in (take or {}).get("units") or []), default=0.0)
                fine = bool(d_new and d_src and abs(d_new - d_src) <= 0.15 and d_new >= need - 0.02)
            if not fine:
                return base, f"「{v.model_id}」版本时长与原片不一致，已改用原片导出"
        steps.append({"desub": "去字幕", "upscale": "高清"}.get(v.model_id, v.model_id))
        url = m.get("src_video_url")
        if not url:
            break
        if url == base:
            return cur, "＋".join(reversed(steps))
    return base, "当前版本不是这次出片的处理版，已用对齐时的原片导出"


def nd_shots(session, project_id: str) -> list[Shot]:
    return [s for s in session.query(Shot).filter(Shot.project_id == project_id)
            .order_by(Shot.order).all() if nd_of(s)]


def model_of(proj, override: str | None = None) -> str:
    from ..jobs import _resolve_project_video_model
    m = override or _resolve_project_video_model(proj)
    return m if m in MODELS else DEFAULT_MODEL


def seg_max(model: str) -> float:
    """一镜最长多少秒（超了 split_overlong 按拍切开）。"""
    return WAN_SEG_MAX if model == WAN else SEG_MAX


def req_dur(model: str, total: float) -> int:
    """向模型要的时长：计划总长 + 0.5s 收尾，夹在模型允许的区间里。"""
    lo, hi = (2, 30) if model == WAN else (4, 15)
    return int(max(lo, min(hi, math.ceil(total + 0.5))))


def windows(beats: list[dict]) -> tuple[list[tuple[float, float]], float]:
    """时间窗：旁白/画外音 = TTS 实长，台词按 4.3 字/秒估，音效 1.2s。返回 (窗, 总长)。"""
    t, out = 0.3, []
    for b in beats:
        if b["k"] in ("narr", "vo"):
            d = (b.get("dur") or B.est_sec(b)) + 0.2
        else:
            d = B.est_sec(b)
        out.append((round(t, 2), round(t + d, 2)))
        t += d + 0.15
    return out, t


# ------------------------------------------------------------------ ① TTS

async def _tts(ref_path: Path, text: str) -> tuple[str, float]:
    """合成一句，裁掉首尾静音，返回 (url, 秒)。"""
    from ..jobs import _tts_gate
    from ..media import GENERATED_DIR, ensure_local_async
    from ..providers.tts import TTSProvider
    tts = TTSProvider()
    async with _tts_gate():
        ref = await tts.upload_ref_voice(ref_path)
        url = await tts.synth(ref, text)
    src = await ensure_local_async(url)
    dst = GENERATED_DIR / f"nd_tts_{uuid.uuid4().hex[:12]}.m4a"
    proc = await asyncio.create_subprocess_exec(
        "ffmpeg", "-v", "error", "-y", "-i", str(src), "-af",
        "silenceremove=start_periods=1:start_threshold=-50dB,areverse,"
        "silenceremove=start_periods=1:start_threshold=-50dB,areverse",
        "-ac", "1", "-ar", "48000", "-c:a", "aac", "-b:a", "128k", str(dst))
    await proc.wait()
    if proc.returncode != 0 or not dst.exists():
        raise RuntimeError("旁白音频处理失败")
    from ..media import probe_duration_local
    out = f"/fw/media/generated/{dst.name}"
    return out, round(await probe_duration_local(out), 3)


async def narrate_shot(sid: str, voice_path: Path) -> None:
    """镜头里缺音频（或文本改过）的旁白/画外音补合成。"""
    with get_session() as session:
        nd = nd_of(session.get(Shot, sid))
    todo = [i for i, b in enumerate(nd["beats"]) if b["k"] in ("narr", "vo")
            and not (b.get("url") and b.get("tts_text") == b["text"])]
    if not todo:
        return
    res = await asyncio.gather(*(_tts(voice_path, nd["beats"][i]["text"]) for i in todo))
    for i, (url, dur) in zip(todo, res):
        nd["beats"][i].update(url=url, dur=dur, tts_text=nd["beats"][i]["text"])
    save_nd(sid, nd)


# ------------------------------------------------------------------ ② 切长镜

def _beat_sec(b: dict) -> float:
    return ((b.get("dur") or B.est_sec(b)) + 0.2 if b["k"] in ("narr", "vo") else B.est_sec(b)) + 0.15


def merge_for_long(project_id: str, cap: float = WAN_SEG_MAX - 1.0) -> int:
    """万相一镜能出 30 秒：把相邻、同集同地点、都还没出片的镜头并成一镜。返回并掉了几镜。

    拆解时不知道将来用哪个模型（按 15 秒拆的），所以在出片前按模型合并——用户中途
    从 Seedance 换成万相也能用上长镜。只并 planned/narrated 的镜头：出过片的镜头
    有剪辑方案，动它会让成片和核对报告对不上。参考图（角色+道具+场景）总数不超过
    breakdown.WAN_MAX_REFS，否则多出来的人没有定妆图。被并掉的镜头直接删除（它们
    没有任何产物），之后全项目重排序号。"""
    n = 0
    with get_session() as session:
        rows = nd_shots(session, project_id)
        prev = None
        for sh in rows:
            nd = nd_of(sh)
            fresh = nd.get("status") in (None, "planned", "narrated") and not sh.video_url
            if prev is None or not fresh:
                prev = sh if fresh else None
                continue
            pnd = nd_of(prev)
            try:
                pc, sc = json.loads(prev.characters or "[]"), json.loads(sh.characters or "[]")
                pp, sp_ = json.loads(prev.props or "[]"), json.loads(sh.props or "[]")
            except (ValueError, TypeError):
                prev = sh
                continue
            chars = list(dict.fromkeys(pc + sc))
            props = list(dict.fromkeys(pp + sp_))
            t = sum(_beat_sec(b) for b in pnd["beats"] + nd["beats"]) + 0.3
            if ((prev.episode or 1) != (sh.episode or 1) or (prev.location or "") != (sh.location or "")
                    or t > cap or len(chars) + len(props) + (1 if sh.location else 0) > B.WAN_MAX_REFS):
                prev = sh
                continue
            beats = pnd["beats"] + nd["beats"]
            states = {**(nd.get("states") or {}), **(pnd.get("states") or {})}
            merged = {**pnd, "beats": beats, "status": pnd.get("status") or "planned",
                      "merged": (pnd.get("merged") or 1) + (nd.get("merged") or 1)}
            if pnd.get("states") is not None or nd.get("states") is not None:
                merged["states"] = states
            merged.pop("en", None)
            ov = json.loads(prev.profile_override or "{}")
            ov["nd"] = merged
            prev.profile_override = json.dumps(ov, ensure_ascii=False)
            prev.characters = json.dumps(chars, ensure_ascii=False)
            prev.props = json.dumps(props, ensure_ascii=False)
            prev.script_ref = B.script_ref_of({"beats": beats})
            prev.duration_sec = float(math.ceil(t + 0.6))
            session.delete(sh)
            n += 1
        if n:
            session.flush()
            for k, r in enumerate(session.query(Shot).filter(Shot.project_id == project_id)
                                  .order_by(Shot.episode, Shot.order).all(), 1):
                r.order = k
        session.commit()
    return n


def split_overlong(project_id: str, cap: float = SEG_MAX) -> int:
    """TTS 实长出来后，超上限（Seedance/H3 14.5s、万相 29s）的镜头按拍切开（新镜插在原镜之后，全项目重排序号）。"""
    n = 0
    with get_session() as session:
        rows = nd_shots(session, project_id)
        for sh in rows:
            nd = nd_of(sh)
            if nd.get("status") not in (None, "planned", "narrated"):
                continue
            parts, cur, t = [], [], 0.0
            for b in nd["beats"]:
                d = _beat_sec(b)
                if cur and t + d + 0.3 > cap:
                    parts.append(cur)
                    cur, t = [], 0.0
                cur.append(b)
                t += d
            if cur:
                parts.append(cur)
            if len(parts) <= 1:
                continue
            n += len(parts) - 1
            # 后面的镜头整体后移，给切出来的新镜头腾出序号
            for later in (session.query(Shot).filter(Shot.project_id == project_id,
                                                     Shot.order > sh.order).all()):
                later.order += len(parts) - 1
            ov = json.loads(sh.profile_override or "{}")
            ov["nd"] = {**nd, "beats": parts[0]}
            sh.profile_override = json.dumps(ov, ensure_ascii=False)
            sh.script_ref = B.script_ref_of({"beats": parts[0]})
            for k, beats in enumerate(parts[1:], 1):
                session.add(Shot(
                    id=uuid.uuid4().hex[:12], project_id=project_id,
                    order=sh.order + k,
                    episode=sh.episode, status="pending",
                    script_ref=B.script_ref_of({"beats": beats}),
                    characters=sh.characters, props=sh.props, location=sh.location,
                    duration_sec=sh.duration_sec,
                    profile_override=json.dumps({"nd": {**nd, "beats": beats}}, ensure_ascii=False)))
            session.flush()
        session.commit()
    return n


# ------------------------------------------------------------------ ③ 提示词与出片

def build_prompt(proj, shot, beats, win, labels: list[str], states: dict | None = None,
                 voices: dict | None = None) -> str:
    """`voices`：角色名 → 档案（见 nd/voice.profiles），用来在每句台词旁写明男女声。"""
    from .. import style_preset as sp
    from .voice import voice_zh
    st = sp.resolve(proj.production_mode, proj.art_style)
    cast = "；".join(f"图片{i}是{l}" for i, l in enumerate(labels, 1))
    lines = []
    for b, (a, e) in zip(beats, win):
        vis = (b.get("vis") or "").rstrip("。")
        if b["k"] in ("narr", "vo"):
            lines.append(f"{a:.1f}-{e:.1f}秒：{vis}。这一段画面里所有人物都闭着嘴，没有人说话，只有环境音。")
        elif b["k"] == "sfx":
            who = b.get("who") or ""
            lines.append(f"{a:.1f}-{e:.1f}秒：{vis}。{who}发出声音：“{b['text']}”。")
        else:
            vz = voice_zh((voices or {}).get(b["who"]))
            lines.append(f"{a:.1f}-{e:.1f}秒：{vis}。{b['who']}{'用' + vz if vz else ''}开口说：“{b['text']}”，说完闭嘴。")
    head = f"{(proj.base_aspect or '9:16')}画幅。{st.video_line}".strip()
    from .state import prompt_lines
    try:
        chars = json.loads(shot.characters or "[]")
    except (ValueError, TypeError):
        chars = []
    st_lines = prompt_lines(states or {}, chars, labels)
    return "\n".join(filter(None, [
        head,
        f"场景：{shot.location}。" if shot.location else "",
        f"参考图：{cast}。" if cast else "",
        # 人物状态台账（2026-11-01）：随身物品/外观整段保持，否则模型只看本镜描述、
        # 前面交代过的铁锹背包在后面的镜头里就消失了
        ("人物状态（整段保持，不凭空消失或替换）：" + "；".join(st_lines) + "。") if st_lines else "",
        *lines,
        "全片没有旁白、没有画外音、没有背景音乐；只有上面写明的台词、声音与环境音。"
        "台词逐字照念、语速自然偏快，句与句之间不停顿；画面中不出现任何文字。"]))


def _label_name(label: str) -> str:
    """「角色「陆知夏」」→ 陆知夏；「场景「超市门口」（主视角）」→ 超市门口。"""
    if "「" in label and "」" in label:
        return label.split("「", 1)[1].split("」", 1)[0]
    return label


def _mmss(t: float) -> str:
    return f"{int(t // 60):02d}:{t % 60:04.1f}"


def build_prompt_wan(proj, shot, beats, win, labels: list[str], states: dict | None = None,
                     voices: dict | None = None, _en: dict | None = None) -> str:
    """万相 wan3.0 的多分镜提示词（百炼「万相 3.0 视频生成提示词」官方公式）。

      总体描述 + 主体锁定（名字 + 图 N）+ 分镜 N（起-止）：画面 + 台词 + 音效/BGM + 风格 + 负向清单

    与 Seedance 那份同一套信息（时间窗、旁白段不说话、台词逐字、男女声、人物状态台账），
    写法换成万相认的：一拍一个分镜、首尾相接；台词「名字（图 N）说："…"」+ 口型同步；
    旁白段写「无台词」——官方说明不写的话模型会自己决定加台词。一镜最长 30 秒，
    所以同一地点的几段戏会并进一条片（merge_for_long），分镜之间硬切。
    """
    from .. import style_preset as sp
    from .state import prompt_lines
    from .voice import voice_zh
    st = sp.resolve(proj.production_mode, proj.art_style)
    img = {_label_name(l): i for i, l in enumerate(labels, 1)}

    def ref(name: str) -> str:
        return f"{name}（图 {img[name]}）" if name in img else name

    try:
        chars = json.loads(shot.characters or "[]")
    except (ValueError, TypeError):
        chars = []
    total = win[-1][1] if win else 0.0
    n = len(beats)
    head = (f"{(proj.base_aspect or '9:16')}竖屏短剧片段，{st.video_line}".rstrip("。") + "。"
            f"全片约 {math.ceil(total)} 秒，{n} 个分镜{'，分镜之间硬切转场' if n > 1 else ''}，"
            "同一场戏，人物、服装、场景在各分镜之间保持一致。")
    lock = "、".join(f"{_label_name(l)}图 {i}" for i, l in enumerate(labels, 1))
    st_lines = [x.replace("（图片", "（图 ") for x in prompt_lines(states or {}, chars, labels)]
    lines = []
    for k, (b, (a, e)) in enumerate(zip(beats, win), 1):
        vis = (b.get("vis") or "").rstrip("。")
        for nm in sorted(img, key=len, reverse=True):
            # 单字名（我）不绑：会切进「我们」「自我」
            if len(nm) >= 2 and nm in vis and f"{nm}（图" not in vis:
                vis = vis.replace(nm, ref(nm), 1)
        tag = f"分镜{k}（{_mmss(a)}-{_mmss(e)}）："
        if b["k"] in ("narr", "vo"):
            lines.append(f"{tag}{vis}。无台词，画面里所有人物闭着嘴不说话，只有环境音和动作音。")
        elif b["k"] == "sfx":
            lines.append(f"{tag}{vis}。{ref(b.get('who') or '')}发出声音：\"{b['text']}\"。")
        else:
            vz = voice_zh((voices or {}).get(b["who"]))
            lines.append(f"{tag}{vis}。{ref(b['who'])}{'用' + vz if vz else ''}开口说：\"{b['text']}\"，"
                         "口型同步，说完闭嘴。")
    return "\n".join(filter(None, [
        head,
        f"主体锁定：{lock}。" if lock else "",
        f"场景：{ref(shot.location)}。" if shot.location else "",
        ("人物状态（整段保持，不凭空消失或替换）：" + "；".join(st_lines) + "。") if st_lines else "",
        *lines,
        "声音：只有上面写明的台词、声音与环境音，台词逐字照念、语速自然偏快，句与句之间不停顿；"
        "无 bgm，无旁白，无画外音。",
        "负向清单：不要字幕、不要水印、不要任何文字；不要人物换脸或身份漂移；"
        "不要服装变化；不要慢动作；不要多余人物。"]))


def build_prompt_h3(proj, shot, beats, win, labels: list[str], states: dict | None = None,
                    voices: dict | None = None, en: dict | None = None) -> str:
    """海螺 H3 的全参考六段式提示词（skill_assets/minimax_h3/references/2-full-reference-mode-guide）。

    与 Seedance 那份同一套信息（时间窗、旁白段不说话、台词逐字、人物状态台账），只是写法
    换成 H3 认的结构：Subject/Picture 编号、(Sx) 说话人、台词放 <d>[Chinese] …</d>、
    画外的段明确 lips remain closed。2026-10-30 第二轮实测这种写法 H3 台词 10/10 全中。

    `en`：h3text.compile_episode 编好的英文（画面描述 / 人物状态 / 名字 / 画风行）。
    **除台词外一个汉字都不能留**——H3 把提示词里的中文当成"场景里本来就有的文字"烧进画面
    （2026-11-01 用户报：第三集「楼道中景」「外套里护着小满」出现在画面里）。
    """
    from .. import style_preset as sp
    from .state import prompt_lines
    from .voice import voice_en
    st = sp.resolve(proj.production_mode, proj.art_style)
    try:
        chars = json.loads(shot.characters or "[]")
    except (ValueError, TypeError):
        chars = []
    voices = voices or {}
    from .h3text import VER as _EN_VER, bare, bind_names, label
    en = en if isinstance(en, dict) and en.get("ver") == _EN_VER else {}   # v1 缓存会撞名，不用
    names = en.get("names") or {}
    en_v = en.get("v") or []
    en_s = en.get("s") or {}
    en_who = en.get("who") or {}

    def nm(x: str) -> str:
        """名字 → 英文。镜头上的地点名常是资产名的简写（「楼道」对「单元楼楼道」），也要对上。"""
        if x in names:
            return names[x]
        for k, v in names.items():
            if k and k != "__style__" and len(x) >= 2 and (x in k or k in x):
                return v
        return x
    pic = {}
    for i, l in enumerate(labels, 1):
        if "「" in l and "」" in l:
            pic[l.split("「", 1)[1].split("」", 1)[0]] = (i, l)
    st_map = {}
    for line in prompt_lines(states or {}, chars, labels):
        who, _, s = line.partition("：")
        st_map[who.split("（", 1)[0]] = s
    def is_creature(c: str) -> bool:
        w = en_who.get(c)
        return bool(w and w["creature"]) or (voices.get(c) or {}).get("form") in ("动物", "非人")

    def voice_of(c: str) -> str:
        """说话人声线（定义行与台词行共用一处，免得一处修了另一处漏）。"""
        w = en_who.get(c)
        ve = voice_en(voices.get(c))
        if en and is_creature(c):
            # 动物：用编译好的英文物种——档案物种是中文「狸花猫」，会被烧进画面
            ve = f"an anthropomorphic {bare(w['desc'])} voice" if w else ""
        if en and re.search(r"[一-鿿]", ve or ""):
            ve = ""
        return ve

    subj, defs = {}, []
    for c in chars:
        subj[c] = len(subj) + 1
        p = f" in <Picture {pic[c][0]}>" if c in pic else ""
    for c in chars:
        extra = (f"; persistent state: {bind_names(en_s[c], subj, en_who) if c in en_s else st_map[c]}"
                 if (c in en_s or c in st_map) else "")
        w = en_who.get(c)
        ve = voice_of(c)
        # 声线写进定义：此前全程没说说话人是男是女，模型只能从参考图猜，女主被配成男声
        vtxt = f"; speaks in {ve}" if ve else ""
        p = f" in <Picture {pic[c][0]}>" if c in pic else ""
        # 角色称呼：专名用拼音 + 是什么（Lu Zhixia, a young woman）；普通名词只用英文描述——
        # v1 泛称撞名致台词安错人；v2 全用拼音把「老鼠」变成叫 Lao Shu 的人、画成腐烂的人
        who = label(c, w) if en else c
        defs.append(f"<Subject {subj[c]}> is {who}{p}{vtxt}{extra}.")
    # 场景/道具图写成 <Subject N>，不单列 <Picture N>：官方指南里单列的 Picture 表示「这张图就是
    # 某镜的首帧/关键帧」。11-02 第 1 镜首拍是纯空镜，H3 把横版场景图直接当首帧定格了 4 秒（带黑边）。
    things: dict[str, tuple[int, str]] = {}
    for name, (i, l) in pic.items():
        if name not in subj:
            kind = "the scene" if l.startswith("场景") else "the prop"
            things[name] = (len(subj) + len(things) + 1, kind)
            defs.append(f"<Subject {things[name][0]}> is {kind} {bind_names(nm(name), subj, en_who)}, "
                        f"whose look comes from <Picture {i}> (a reference for design only, not a frame "
                        f"of the video).")
    speakers = []
    for b in beats:
        if b["k"] in ("dlg", "sfx") and b.get("who") and b["who"] not in speakers:
            speakers.append(b["who"])
    sid = {w: k for k, w in enumerate(speakers, 1)}
    shots = []
    for k, (b, (a, e)) in enumerate(zip(beats, win), 1):
        # 画面描述用编译好的英文；没编译到（翻译失败）才退回中文——那会有烧字风险，但没描述更糟
        vis = (bind_names(en_v[k - 1], subj, en_who).rstrip(". ") if k - 1 < len(en_v) and en_v[k - 1] else
               (b.get("vis") or "").rstrip("。"))
        if b["k"] in ("narr", "vo"):
            line = "No one speaks; every character's lips remain completely closed; only ambience."
        else:
            who = b.get("who") or ""
            tag = f"<Subject {subj[who]}> ({'S' + str(sid[who]) if who in sid else ''})" if who in subj else who
            ve = voice_of(who)
            verb = ("makes the sound" if b["k"] == "sfx" else
                    f"speaks quickly on camera in {ve}" if ve else "speaks quickly on camera")
            line = f"{tag} {verb}: <d>[Chinese] {b['text']}</d> then closes the mouth."
        place = bind_names(nm(shot.location), subj, en_who) if shot.location else ""
        shots.append(f"[Shot {k}] At 00:{a:06.3f}, {place}. {vis}. {line}")
    def _ret(c: str, n: int) -> str:
        what = "species, body, fur and markings" if is_creature(c) else "identity, hairstyle, outfit"
        return (f"<Subject {n}>: fully_preserved - {what} and the persistent state "
                f"(carried items stay visible) are retained in every shot.")
    ret = [_ret(c, n) for c, n in subj.items()] + [
        f"<Subject {n}>: transferred - " + ("layout, materials and lighting of the place are reused "
                                           f"in a moving {proj.base_aspect or '9:16'} shot"
                                           if kind == "the scene" else
                                           "shape, colour and wear of the object are reused") + "."
        for n, kind in things.values()]
    return "\n".join([
        "subject_definitions:", *defs, "",
        "summary:",
        f"[reference generation] A fast-paced {proj.base_aspect or '9:16'} Chinese short drama. "
        "Characters speak their own lines on camera back to back; there is no narrator voice, "
        "no subtitles and no on-screen text.", "",
        "retention_analysis:", *ret, "",
        "detailed_description:",
        f"The target video style: {names.get('__style__') or st.video_line}",
        *shots, "",
        "overall_soundscape:",
        "Only the on-camera dialogue and light ambience; no narration, no voiceover, no music.", "",
        "non_diegetic_music:", "N/A"])


async def generate(sid: str, model: str, attempt: int) -> dict:
    """出一条片。返回 {"ok", "video_url"|"error", "prompt"}。"""
    from ..jobs import (_auto_inject_refs_with_source, _save_shot_version,
                        _to_trusted_assets, _video_pool, _resolve_project_resolution)
    from ..media import make_thumb
    from ..providers.base import VideoRequest
    from ..providers.registry import registry
    from ..shot_timing import RESOLUTION_TIERS
    prov = registry.get_video(model)
    if prov is None:
        return {"ok": False, "error": f"视频模型 {model} 未开通"}
    with get_session() as session:
        sh = session.get(Shot, sid)
        proj = session.get(Project, sh.project_id)
        nd = nd_of(sh)
        mp = RESOLUTION_TIERS.get(_resolve_project_resolution(proj) or "720p") or 0.9
        aspect = proj.base_aspect or "9:16"
    cap = getattr(prov, "max_reference_images", 9) or 9
    urls, labels, _notes, _src = await asyncio.to_thread(_auto_inject_refs_with_source, sid, cap)
    refs = await _to_trusted_assets(sid, urls,
                                    uses_ark_assets=getattr(prov, "uses_ark_trusted_assets", False))
    win, total = windows(nd["beats"])
    dur = req_dur(model, total)
    with get_session() as session:
        sh = session.get(Shot, sid)
        proj = session.get(Project, sh.project_id)
        from .voice import profiles
        prompt = (build_prompt_h3 if model == H3 else build_prompt_wan if model == WAN
                  else build_prompt)(
            proj, sh, nd["beats"], win, labels, nd.get("states"), profiles(session, proj.id),
            nd.get("en"))
    if model == H3:
        # H3 单次时长受显存约束（plus 机型 20 MP·s）：项目选 1080p（2.0MP）时 15s 镜头会爆显存。
        # 按本镜时长把分辨率压到包线内（留 5% 余量），时长优先——镜头长度是剪辑方案定的。
        from ..providers.video_runninghub import vram_budget
        mp = min(mp, round(vram_budget(prov.instance_type) * 0.95 / max(dur, 1), 2))
    req = VideoRequest(prompt=prompt, reference_image_urls=refs, duration_ms=dur * 1000,
                       aspect_ratio=aspect, megapixels=mp)
    async with _video_pool():
        res = await prov.submit(req)
    if res.status != "done" or not res.video_url:
        return {"ok": False, "error": (res.error or "出片失败")[:300], "prompt": prompt}
    thumb = await make_thumb(res.video_url)
    vno = _save_shot_version(sid, res.video_url, model, prompt,
                             {"nd": True, "attempt": attempt, "windows": win,
                              "refs": labels}, thumb_url=thumb)
    return {"ok": True, "video_url": res.video_url, "thumb_url": thumb, "version": vno,
            "prompt": prompt, "windows": win, "dur_req": dur}


# ------------------------------------------------------------------ ④ 对齐与核对

async def align_take(video_url: str, beats: list[dict], win,
                     genders: dict[str, str] | None = None) -> dict:
    """一条片 → {units, fid, min_ratio, missing, extra, wrong_voice}。fill 单元先只留窗口。

    `genders`：角色名 → 男/女（只有性别明确的才在里面）。每句台词测基频，与性别明显
    相反的记进 fid[].voice 并计入 wrong_voice。"""
    from ..media import ensure_local_async
    local = await ensure_local_async(video_url)
    x = await asyncio.to_thread(A.pcm, local)
    vdur = len(x) / A.SR
    rs = A.runs(x)
    rc = await A.transcribe_runs(x, rs)
    di = [i for i, b in enumerate(beats) if b["k"] == "dlg"]
    loc = dict(zip(di, A.locate(x, rs, rc, [beats[i]["text"] for i in di])))
    units, _ = A.plan(x, vdur, beats, win, loc)
    units = [A.fit(u, beats[u["beat"]]["dur"] + 0.1, vdur) if u["k"] == "narr" else
             {**u, "speed": 1.0, "dur": round(u["e"] - u["s"], 3)} for u in units]
    from .voice import check as voice_check
    fid = []
    span = {u["beat"]: (u["s"], u["e"]) for u in units if u["k"] == "dlg"}
    for i in di:
        l = loc[i]
        d = T.diff_line(beats[i]["text"], l["heard"]) if l["start"] is not None else \
            {"ratio": 0.0, "heard": "", "miss": [T.clean(beats[i]["text"])], "extra": [], "swap": []}
        vc = None
        if i in span:
            vc = voice_check(x, *span[i], (genders or {}).get(beats[i].get("who") or "", ""))
        fid.append({"beat": i, "said": l["start"] is not None, **d, **({"voice": vc} if vc else {})})
    judged = [f for f in fid if len(T.clean(beats[f["beat"]]["text"])) > 1]
    return {"units": units, "fid": fid, "vdur": round(vdur, 3),
            "min_ratio": min((f["ratio"] for f in judged), default=1.0),
            "missing": sum(1 for f in fid if not f["said"]),
            "wrong_voice": sum(1 for f in fid if f.get("voice") and not f["voice"]["ok"]),
            "frozen": await asyncio.to_thread(frozen_sec, local),
            "extra": A.extra_speech(units, rs, rc, beats)}


FREEZE_MAX = 1.5      # 连续这么久画面不动就算「定格」（11-02：H3 把场景参考图当首帧定格 4.2 秒）


def frozen_sec(path) -> float:
    """片子里最长的一段静止画面（秒）。ffmpeg freezedetect，测不了返回 0（不因检测失败误判）。"""
    import subprocess
    try:
        r = subprocess.run(["ffmpeg", "-v", "info", "-i", str(path), "-vf", "freezedetect=n=0.01:d=1",
                            "-an", "-f", "null", "-"], capture_output=True, text=True, timeout=120).stderr
    except Exception:  # noqa: BLE001
        return 0.0
    du = [float(x) for x in re.findall(r"freeze_duration: ([\d.]+)", r)]
    return round(max(du), 2) if du else 0.0


def _score(take: dict) -> tuple:
    # 漏念 > 画面定格 > 声线反了 > 台词一致度
    return (-take["missing"], -int(take.get("frozen", 0) >= FREEZE_MAX), -take.get("wrong_voice", 0),
            take["min_ratio"])


def needs_retry(take: dict, beats) -> bool:
    if take.get("wrong_voice") or take.get("frozen", 0) >= FREEZE_MAX:
        return True
    for f in take["fid"]:
        if len(T.clean(beats[f["beat"]]["text"])) <= 1:
            continue                       # 单字句（「谁？」）ASR 不可靠，不据此重出
        if not f["said"] or f["ratio"] < RETRY_RATIO:
            return True
    return False


async def produce_shot(sid: str, model: str, cancelled) -> dict:
    """单镜：出片 → 对齐 → 不过关重出一次 → 留最好的那版。"""
    with get_session() as session:
        nd = nd_of(session.get(Shot, sid))
    beats = nd["beats"]
    from .voice import gender_of, profiles
    with get_session() as session:
        pid = session.get(Shot, sid).project_id
        genders = {n: gender_of(p) for n, p in profiles(session, pid).items() if gender_of(p)}
    takes = []
    for attempt in range(1, MAX_ATTEMPTS + 1):
        if cancelled():
            break
        nd["status"] = "generating"
        nd["attempts"] = attempt
        save_nd(sid, nd, status="generating")
        g = await generate(sid, model, attempt)
        if not g["ok"]:
            # 出片失败（审核拦截/上游故障）不计费，下一轮再试一次
            nd["error"] = g["error"]
            log.warning("[nd] 镜头 %s 第 %d 次出片失败：%s", sid, attempt, g["error"])
            continue
        nd["status"] = "aligning"
        save_nd(sid, nd)
        try:
            al = await align_take(g["video_url"], beats, g["windows"], genders)
        except Exception as e:  # noqa: BLE001
            log.exception("[nd] 对齐失败 %s", sid)
            al = {"units": [], "fid": [], "min_ratio": 0.0, "missing": 99, "extra": [],
                  "error": human_error(e)}
        take = {**g, **al, "attempt": attempt}
        takes.append(take)
        if not needs_retry(take, beats):
            break
        log.info("[nd] 镜头 %s 第 %d 次核对不过（最低 %.2f、没念 %d 句、声线反了 %d 句），%s", sid, attempt,
                 take["min_ratio"], take["missing"], take.get("wrong_voice", 0),
                 "自动重出" if attempt < MAX_ATTEMPTS else "保留最好版")
    if not takes:
        nd["status"] = "failed"
        save_nd(sid, nd, status="failed")
        return nd
    best = max(takes, key=_score)
    nd.update(status="aligned", error=None, take=best, attempts=len(takes),
              takes=[{k: t.get(k) for k in ("attempt", "video_url", "min_ratio", "missing", "wrong_voice")}
                     for t in takes])
    save_nd(sid, nd, status="adopted", video_url=best["video_url"],
            thumb_url=best.get("thumb_url"), adopted_version=best.get("version"))
    return nd


# ------------------------------------------------------------------ ⑥ 漏念补位

def _voice_for(project_id: str, who: str, narr_voice: str | None) -> tuple[str | None, str]:
    """补位音色：角色资产音色 → 该角色在别的镜头里的原声（≥1.8s）→ 解说音色。"""
    with get_session() as session:
        a = (session.query(Asset).filter(Asset.project_id == project_id, Asset.kind == "character",
                                         Asset.name == who, Asset.deleted_at.is_(None)).first())
        if a and a.voice_url:
            return a.voice_url, "角色音色"
        for sh in nd_shots(session, project_id):
            nd = nd_of(sh)
            tk = nd.get("take") or {}
            for u in tk.get("units") or []:
                b = nd["beats"][u["beat"]] if u["beat"] < len(nd["beats"]) else {}
                if u["k"] == "dlg" and b.get("who") == who and u["e"] - u["s"] >= 1.8:
                    return f"{tk['video_url']}#t={u['s']},{u['e']}", "该角色在别处的原声"
    return narr_voice, "解说音色"


async def _ref_path(ref: str) -> Path:
    """音色来源 → 本地参考音频（视频片段的话先切出来）。"""
    from ..media import GENERATED_DIR, ensure_local_async
    if "#t=" in ref:
        url, span = ref.split("#t=", 1)
        a, b = (float(v) for v in span.split(","))
        src = await ensure_local_async(url)
        dst = GENERATED_DIR / f"nd_vref_{uuid.uuid4().hex[:10]}.wav"
        proc = await asyncio.create_subprocess_exec(
            "ffmpeg", "-v", "error", "-y", "-ss", f"{a:.3f}", "-to", f"{b:.3f}", "-i", str(src),
            "-vn", "-ac", "1", "-ar", "44100", str(dst))
        await proc.wait()
        return dst
    return await ensure_local_async(ref)


async def fill_missing(project_id: str, sid: str, narr_voice: str | None) -> None:
    with get_session() as session:
        nd = nd_of(session.get(Shot, sid))
    tk = nd.get("take")
    if not tk:
        return
    changed = False
    for u in tk["units"]:
        if u["k"] != "fill" or u.get("audio"):
            continue
        b = nd["beats"][u["beat"]]
        ref, why = _voice_for(project_id, b.get("who") or "", narr_voice)
        if not ref:
            continue
        url, dur = await _tts(await _ref_path(ref), b["text"])
        u.update(A.fit(u, dur + 0.1, tk.get("vdur") or 15.0), audio=url, voice=why)
        changed = True
    if changed:
        save_nd(sid, nd)


# ------------------------------------------------------------------ 报价

def estimate(payload: dict) -> tuple[int, str]:
    from .. import pricing
    from ..jobs import _resolve_project_resolution
    pid = payload.get("project_id")
    with get_session() as session:
        proj = session.get(Project, pid)
        if not proj:
            return 0, "项目不存在"
        shots = [s for s in nd_shots(session, pid) if _in_scope(s, payload)]
        model = model_of(proj, payload.get("model_id"))
        res = _resolve_project_resolution(proj) or "720p"
    if not shots:
        return 0, "没有要出片的镜头"
    secs = sum(req_dur(model, windows(nd_of(s)["beats"])[1]) for s in shots)
    n_tts = sum(1 for s in shots for b in nd_of(s)["beats"]
                if b["k"] in ("narr", "vo") and not b.get("url"))
    if model == H3:
        # 海螺 H3 按机时计费、生成耗时没法预估：与通用出片同口径按输出秒数预扣，结算多退少补
        fen = int(secs * pricing.H3_PREHOLD_PER_VIDEO_SEC)
    elif pricing.is_wan(model):
        fen = pricing.wan_cost(res, secs)        # 万相按输出秒数，官方价七折
    else:
        fen = pricing.seedance_cost(model, res, pricing.seedance_tokens_estimate(res, secs))
    fen += pricing.tts_cost(n_tts) if n_tts else 0
    return fen, (f"{len(shots)} 镜 / 约 {secs}s / {res}；核对不过的镜头会自动重出一次，"
                 f"按实际用量结算")


def _in_scope(sh, p: dict) -> bool:
    if p.get("shot_ids"):
        return sh.id in set(p["shot_ids"])
    if p.get("episodes") and (sh.episode or 1) not in set(p["episodes"]):
        return False
    st = nd_of(sh).get("status")
    return bool(p.get("redo")) or st not in ("aligned",)


# ------------------------------------------------------------------ 任务入口

async def run_nd_breakdown(jid: str) -> None:
    from ..jobs import _update, get_job
    from ..script_import import smart_split_chapters, too_short_to_break_down
    job = get_job(jid)
    if not job:
        return
    p = json.loads(job.payload or "{}")
    pid = p.get("project_id")
    with get_session() as session:
        proj = session.get(Project, pid)
        raw = proj.raw_script if proj else None
        done = {s.episode for s in nd_shots(session, pid)} if proj else set()
    if not raw:
        _update(jid, status="failed", error="项目还没有剧本，请先导入")
        return
    chapters = [c for c in smart_split_chapters(raw) if not too_short_to_break_down(c)]
    want = set(p.get("episodes") or [])
    todo = ([c for c in chapters if c["order"] in want] if want else
            [c for c in chapters if p.get("force") or c["order"] not in done])
    if not todo:
        _update(jid, status="done", progress=100,
                result=json.dumps({"episodes": [], "note": "全部集都已拆好"}, ensure_ascii=False))
        return
    _update(jid, status="running", progress=1)
    results, lock, cnt = [], asyncio.Lock(), [0]

    async def one(ch):
        try:
            shots, notes = await B.breakdown_episode(ch["content"], p.get("model_id"))
            n = await B.persist(pid, ch["order"], shots)
            r = {"episode": ch["order"], "title": ch["title"], "shots": n,
                 **({"fixes": notes} if notes else {})}
        except Exception as e:  # noqa: BLE001
            log.exception("[nd] 拆解第 %s 集失败", ch["order"])
            r = {"episode": ch["order"], "title": ch["title"], "error": human_error(e)}
        async with lock:
            results.append(r)
            cnt[0] += 1
            _update(jid, progress=max(1, int(cnt[0] / len(todo) * 100)),
                    result=json.dumps({"episodes": sorted(results, key=lambda x: x["episode"])},
                                      ensure_ascii=False))

    await asyncio.gather(*(one(c) for c in todo))
    bad = [r for r in results if "error" in r]
    _update(jid, status="failed" if len(bad) == len(results) else "done", progress=100,
            result=json.dumps({"episodes": sorted(results, key=lambda x: x["episode"])},
                              ensure_ascii=False),
            error="；".join(f"第{r['episode']}集：{r['error']}" for r in bad)[:500] or None)


async def run_nd_produce(jid: str) -> None:
    from ..jobs import _update, get_job, is_cancelled, set_job_phase
    from ..media import ensure_local_async
    job = get_job(jid)
    if not job:
        return
    p = json.loads(job.payload or "{}")
    pid = p.get("project_id")
    with get_session() as session:
        proj = session.get(Project, pid)
        if not proj:
            _update(jid, status="failed", error="项目不存在")
            return
        model = model_of(proj, p.get("model_id"))
        voice = proj.narration_voice_url
        ids = [s.id for s in nd_shots(session, pid) if _in_scope(s, p)]
    if not ids:
        _update(jid, status="done", progress=100, result=json.dumps({"note": "没有要出片的镜头"},
                                                                   ensure_ascii=False))
        return
    need_voice = False
    with get_session() as session:
        for sid in ids:
            if any(b["k"] in ("narr", "vo") for b in nd_of(session.get(Shot, sid))["beats"]):
                need_voice = True
                break
    if need_voice and not voice:
        _update(jid, status="failed", error="请先上传解说音色（旁白要用它合成）")
        return
    _update(jid, status="running", progress=1)

    def cancelled() -> bool:
        return is_cancelled(jid)

    # ① 旁白
    set_job_phase(jid, {"label": "合成旁白"})
    vpath = await ensure_local_async(voice) if voice else None
    errs: list[str] = []
    rs = await asyncio.gather(*(narrate_shot(s, vpath) for s in ids), return_exceptions=True)
    for s, r in zip(ids, rs):
        if isinstance(r, Exception):
            errs.append(f"旁白合成失败：{r}"[:150])
            log.exception("[nd] 旁白合成失败 %s", s, exc_info=r)
    if errs:
        _update(jid, status="failed", error=errs[0])
        return
    # ② 万相一镜能出 30 秒：先把同地点的短镜并成长镜，再切超长的（切出来的新镜头也在范围内）
    before = set(ids)
    if model == WAN and merge_for_long(pid):
        with get_session() as session:
            alive = {s.id for s in nd_shots(session, pid)}
        ids = [s for s in ids if s in alive]
        before = set(ids)
    if split_overlong(pid, seg_max(model)):
        with get_session() as session:
            all_nd = nd_shots(session, pid)
            ids = [s.id for s in all_nd if s.id in before or
                   (nd_of(s).get("status") in (None, "planned") and _in_scope(s, p))]
    # ②b 人物状态台账（每集一次；已有的不重算）
    set_job_phase(jid, {"label": "整理人物状态"})
    from .state import infer_episode
    with get_session() as session:
        eps = sorted({(session.get(Shot, s).episode or 1) for s in ids})
    await asyncio.gather(*(infer_episode(pid, e, p.get("model_id_text")) for e in eps))
    if model == H3:
        # H3 只许中文留在台词里：画面描述/人物状态/名字/画风行编成英文，否则会被烧进画面
        set_job_phase(jid, {"label": "编译 H3 提示词"})
        from .h3text import compile_episode
        await asyncio.gather(*(compile_episode(pid, e, p.get("model_id_text")) for e in eps))
    # ③④⑤ 出片、对齐、重出
    set_job_phase(jid, {"label": "出片与核对"})
    done = [0]

    async def one(sid):
        if cancelled():
            return
        try:
            await produce_shot(sid, model, cancelled)
        except Exception as e:  # noqa: BLE001
            log.exception("[nd] 镜头 %s 失败", sid)
            with get_session() as session:
                nd = nd_of(session.get(Shot, sid))
            nd.update(status="failed", error=str(e)[:200])
            save_nd(sid, nd, status="failed")
        done[0] += 1
        _update(jid, progress=max(1, int(done[0] / len(ids) * 90)))

    await asyncio.gather(*(one(s) for s in ids))
    # ⑥ 漏念补位
    set_job_phase(jid, {"label": "补念漏掉的台词"})
    await asyncio.gather(*(fill_missing(pid, s, voice) for s in ids), return_exceptions=True)
    set_job_phase(jid, None)
    with get_session() as session:
        rows = [session.get(Shot, s) for s in ids]
        sts = [nd_of(r).get("status") for r in rows if r]
    ok = sum(1 for s in sts if s == "aligned")
    # 有一镜出了片就算 done：settle 对 failed 会全额退款，而出了片的那部分钱已经花了
    _update(jid, status="done" if ok else "failed", progress=100,
            result=json.dumps({"shots": len(ids), "ok": ok, "failed": len(ids) - ok},
                              ensure_ascii=False),
            error=None if ok else "全部镜头出片失败")
