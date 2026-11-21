"""给 agent 读的「镜头事实」：读工具与音色工具共用的一份口径。

## 为什么是"事实"而不是"判断"

「两镜是不是在演同一个动作」「这一镜塞的事情是不是太多」「这句台词是谁说的」
都是语义判断，交给读全文的模型做；机械的相似度阈值换个措辞就漏、调低就误报。
这里只给**模型自己算不准、或根本看不到**的东西：

  · 这一镜要念多少**字**（`dialogue_chars`）—— 数得出来的事实
  · 本项目**实测**的语速（`speech_rate.measure` / `shot_rates`），有真实字幕才有
  · 当前视频模型单镜能出多长（`shot_timing.shot_seconds_cap`）
  · 拆解阶段标的动作强度（藏在 profile_override.directing_note 里）
  · 剧本解析出来的说话人、他们有没有上传音色
  · 本镜此刻挂了哪几段音色、各自的编号，以及上一版出片时音色到底用没用上

⚠️ **字数是事实，语速是每个项目自己的数据。** 2026-10-24 之前这里给的是
「台词按 3.1 字/秒念完至少要几秒」，那是拿一个平台常数（且只标定于 n=2）
冒充事实 —— 用它做判据会把一半正常出片的镜头判成"念不完"。已撤掉。

三个工具（read_shots / get_shot / set_shot_voices）看到的必须是同一份，
否则会出现"读的时候说他有音色、挂的时候说找不到"。
"""
from __future__ import annotations

import json

from ..db import Asset, Project, Shot, ShotVersion, profile_of

#: 提示词里引用角色音色的写法。出片前 `at_refs.resolve_at_refs` 会把它转成
#: 「音频N」（编号按真实下发顺序），手改稿、预生成稿、优化稿三条路径都过。
VOICE_TOKEN = "@{name}的音色"


def _override(sh) -> dict:
    try:
        ov = json.loads(sh.profile_override) if sh.profile_override else {}
    except (ValueError, TypeError):
        ov = {}
    return ov if isinstance(ov, dict) else {}


def _json_list(raw) -> list:
    try:
        v = json.loads(raw or "[]")
    except (ValueError, TypeError):
        return []
    return v if isinstance(v, list) else []


class ProjectVoices:
    """本项目的角色音色表 + 别名表（一次查询，供整批镜头复用）。"""

    def __init__(self, session, project_id: str):
        from .. import asset_gate
        from ..char_alias import canonical_character_map

        rows = asset_gate.alive(
            session.query(Asset).filter(Asset.project_id == project_id,
                                        Asset.kind == "character")).all()
        #: 角色名 → 音色 url（只收真有音色的）
        self.by_name: dict[str, str] = {}
        #: 全部活着的角色名（有没有音色都算，用来区分"没传"与"不是角色"）
        self.names: set[str] = set()
        for a in rows:
            nm = (a.name or "").strip()
            if not nm:
                continue
            self.names.add(nm)
            if (a.voice_url or "").strip():
                self.by_name.setdefault(nm, a.voice_url.strip())
        self.by_url: dict[str, str] = {u: n for n, u in self.by_name.items()}
        try:
            self.alias = canonical_character_map(session, project_id) or {}
        except Exception:  # noqa: BLE001 — 别名表坏了就按原名，不影响读
            self.alias = {}

    def canonical(self, name: str) -> str:
        """剧本写法 → 资产库里的名字。"「林母」在资产库叫「林母（张氏）」"这类
        对不上，靠的是拆解时写下的别名表，不是模糊匹配。"""
        n = (name or "").strip()
        if n in self.names:
            return n
        c = (self.alias.get(n) or "").strip()
        return c if c else n

    def voice_of(self, name: str) -> str | None:
        return self.by_name.get(self.canonical(name))


def model_cap_sec(project_id: str, session) -> float | None:
    from ..shot_timing import shot_seconds_cap
    p = session.get(Project, project_id)
    if not p:
        return None
    try:
        return round(float(shot_seconds_cap(profile_of(p))[0]), 1)
    except Exception:  # noqa: BLE001
        return None


def last_voice_ref(session, shot_id: str) -> dict | None:
    """上一版出片时音色的实际情况（`run_shot_videos` 写进版本 meta 的 voice_ref）。

    用上了是 `{url, label}`，没用上是 `{skipped: 原因}`。没有版本 / 那一版没记
    → None。这是回答"我传的音色到底用没用上"的唯一证据。
    """
    v = (session.query(ShotVersion).filter(ShotVersion.shot_id == shot_id)
         .order_by(ShotVersion.version_no.desc()).first())
    if not v or not v.meta:
        return None
    try:
        meta = json.loads(v.meta)
    except (ValueError, TypeError):
        return None
    vr = meta.get("voice_ref") if isinstance(meta, dict) else None
    if not isinstance(vr, dict):
        return None
    out = {"version_no": v.version_no}
    if vr.get("skipped"):
        out["used"] = False
        out["reason"] = str(vr["skipped"])
    else:
        out["used"] = bool(vr.get("url"))
        out["label"] = vr.get("label")
    return out


def voices_on_shot(sh, voices: ProjectVoices) -> list[dict]:
    """本镜此刻**点名挂上**的音色（override.ref_audios），按编号顺序。

    编号 = 在 ref_audios 里的位置（与前端 voiceIdxOf、后端 _merge_ref_audios 同一口径）。
    自动注入的说话人音色不在这里：它在出片时才决定，且排在这些之后。
    """
    ov = _override(sh)
    labels = ov.get("ref_audio_labels") if isinstance(ov.get("ref_audio_labels"), dict) else {}
    out = []
    for i, u in enumerate([x for x in (ov.get("ref_audios") or [])
                           if isinstance(x, str) and x.strip()]):
        nm = voices.by_url.get(u)
        out.append({"audio_no": i + 1,
                    "character": nm,
                    "temp_label": None if nm else (labels.get(u) or "临时参考音频"),
                    "token": VOICE_TOKEN.format(name=nm) if nm else None})
    return out


def speakers_of(script_ref: str, voices: ProjectVoices) -> list[dict]:
    """剧本格式（`角色【情绪】：台词`）里解析出来的说话人，按说话时长降序。

    ⚠️ 这只是**解析结果**，不是结论：小说体写法、旁白里转述的话、「众人：」
    这类集体台词都会让它不准。agent 要以自己读原文的判断为准。
    """
    from ..drama_timing import speaker_seconds
    sp = speaker_seconds(script_ref or "")
    out = []
    for name, sec in sorted(sp.items(), key=lambda kv: (-kv[1], kv[0])):
        canon = voices.canonical(name)
        out.append({"name": name,
                    "asset_name": canon if canon != name else None,
                    "seconds": round(sec, 1),
                    "has_voice": canon in voices.by_name,
                    "is_character": canon in voices.names})
    return out


def shot_facts(session, sh, voices: ProjectVoices, cap_sec: float | None,
               *, full_text: bool = True, rates: dict | None = None) -> dict:
    """单镜的事实全集。`full_text=False` 时不带提示词/剧本正文（给列表用）。

    `rates`：`speech_rate.shot_rates(project_id)` 的结果（可选，避免逐镜重查）。

    ## 关于语速（2026-10-24 用户裁定）

    此前这里给的是 `speak_floor_sec`（按平台常数 3.1 字/秒算"台词念完至少要几秒"）。
    用户指出那个标准不对、agent 不该用它。核过后确认：

      · 拿 74 个**已正常出片**的带台词镜头反查，它把 40 个（54%）判成"念不完"
        —— 而那些镜头全都出片成功；3.1 恰好是这批镜头的中位数。
      · 实测跨度 1.80~4.76 字/秒（p10~p90），单个常数不可能是"下限"。
      · 项目之间也不同：四个 ASR 项目实测 3.77 / 3.33 / 4.09 / 3.07。

    现在改成分两件事给：
      · `dialogue_chars` —— 按剧本原文**解析**出来的字数。⚠️ 它**不是**绝对准确的：
        实测 71 个可对照样本里 17% 偏差超过 50%（小说体没标签、台词跨镜、
        script_ref 是旧稿）。多数时候准，当作量级参考，别当精确值。
      · `measured_cps` + `measured_subtitle_sec` —— 这个项目**自己量出来**的语速
        与该镜**实际转写**的时长。这是最硬的一档数据（有真实字幕才有），
        且只有字幕锚点体检通过时才会出现。
        没有就不给这些键，绝不填常数冒充事实。
    时长该给多少，由模型结合剧本内容自己判断。
    """
    from ..db import effective_characters
    from ..drama_timing import dialogue_chars

    ov = _override(sh)
    dn = ov.get("directing_note") if isinstance(ov.get("directing_note"), dict) else {}
    ref = sh.script_ref or ""
    nchars = dialogue_chars(ref)
    dur = float(sh.duration_sec or 0) or None
    row = {
        "id": sh.id, "order": sh.order, "episode": sh.episode,
        "duration_sec": dur,
        #: 这一镜要念出来的字数（同期台词 + 画外音，不含动作描述）
        "dialogue_chars": nchars,
        "model_cap_sec": cap_sec,
        "action_intensity": (str(dn.get("action_intensity") or "").strip().lower()
                             or None),
        "prompt_state": sh.prompt_state,
        "manual_prompt": bool(ov.get("prompt")),
        "characters": effective_characters(sh),
        "location": sh.location,
        # 与上一镜的衔接：true = 连续（同一场戏接着演），false = 换场/转场
        "link_to_prev": sh.link_to_prev == "continuous",
        "props": _json_list(sh.props),
        "speakers": speakers_of(ref, voices),
        "voices": voices_on_shot(sh, voices),
        "has_video": bool(sh.video_url),
        "stale": bool(sh.stale), "stale_reason": sh.stale_reason,
    }
    # 本项目实测语速（有真实字幕才有）。这是唯一该被当成"事实"的语速。
    m = (rates or {}).get(sh.id)
    if m:
        row["measured_cps"] = m.get("cps")
        row["measured_subtitle_sec"] = m.get("subtitle_sec")
    # 两个最常见的硬问题直接点出来（事实，不是建议）
    flags = []
    if dur and cap_sec and dur > cap_sec + 0.05:
        flags.append(f"时长 {dur:.1f}s 超过当前模型单镜上限 {cap_sec:.1f}s，会被截断")
    if flags:
        row["flags"] = flags
    if full_text:
        # 手改稿以 override.prompt 为准（出片时它优先），否则是 gen_prompt
        row["script_ref"] = ref
        row["prompt"] = (ov.get("prompt") or sh.gen_prompt or "") or None
    return row
